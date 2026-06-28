#!/usr/bin/env python3
"""
make_preview.py — TidyTool design-approval helper.

Render a drawer's DXF to a web preview PNG, upload BOTH the PNG and the DXF to
the public `drawer-assets` bucket at a *versioned* path (so nothing is ever
overwritten), log the revision in the append-only changelog, and print the
customer approval link.

This is the per-client processing step. It runs on YOUR machine with the
SERVICE ROLE key (never the anon key, never in the website). The bucket is
public-read, so the resulting URLs render directly in the approval page.

Versioned storage — every upload is permanent:
    approvals/{drawer_id}/rev-{n}.png
    approvals/{drawer_id}/rev-{n}.dxf

Each run calls the `log_design_revision` RPC, which bumps the drawer's revision,
points `design_preview_url`/`dxf_url` at the new files, resets approval to
`pending` (a new image needs re-approval), and appends a `design_uploaded`
(rev 1) or `design_revised` event to the changelog. The previous revision's
files and events are left untouched.

------------------------------------------------------------------------------
Setup (once):
    cd tools
    python3 -m venv .venv && source .venv/bin/activate
    pip install -r requirements.txt

Credentials (export in your shell or an uncommitted .env):
    export SUPABASE_URL="https://tkrrvpoupekrjqditupi.supabase.co"
    export SUPABASE_SERVICE_ROLE_KEY="<service_role key from Supabase dashboard>"

Usage:
    # Existing drawer (e.g. created by tidyCAM):
    python make_preview.py --dxf ./design.dxf --drawer-id <uuid>

    # New approval drawer (hand-made design):
    python make_preview.py --dxf ./design.dxf --create --nickname "BTECH Capstone"

    # Optional: --note "Revised pocket layout"   --order-id <uuid>   --no-dxf-upload
------------------------------------------------------------------------------
"""

import argparse
import os
import sys
import uuid

import requests

APPROVE_BASE = "https://thetidytool.com/approve/?id="
BUCKET = "drawer-assets"
PREVIEW_PREFIX = "approvals"


def env(name: str) -> str:
    val = os.environ.get(name)
    if not val:
        sys.exit(f"ERROR: environment variable {name} is not set. See the header of this script.")
    return val


def render_png(dxf_path: str, out_path: str, dpi: int = 120) -> None:
    """Render the DXF modelspace to a PNG. Matches the proven preview look."""
    try:
        import ezdxf
        from ezdxf.addons.drawing import RenderContext, Frontend
        from ezdxf.addons.drawing.matplotlib import MatplotlibBackend
        import matplotlib
        matplotlib.use("Agg")
        import matplotlib.pyplot as plt
    except ImportError:
        sys.exit("ERROR: missing deps. Run: pip install -r requirements.txt")

    if not os.path.isfile(dxf_path):
        sys.exit(f"ERROR: DXF not found: {dxf_path}")

    doc = ezdxf.readfile(dxf_path)
    msp = doc.modelspace()

    fig = plt.figure(figsize=(10, 10))
    ax = fig.add_axes([0, 0, 1, 1])
    Frontend(RenderContext(doc), MatplotlibBackend(ax)).draw_layout(msp, finalize=True)
    fig.savefig(out_path, dpi=dpi, bbox_inches="tight", pad_inches=0.1)
    plt.close(fig)

    size_kb = os.path.getsize(out_path) / 1024
    print(f"  rendered {out_path} ({size_kb:.0f} KB)")
    if size_kb > 400:
        print("  NOTE: preview >400 KB. Consider lowering --dpi for faster mobile load.")


def headers(key: str, **extra) -> dict:
    h = {"apikey": key, "Authorization": f"Bearer {key}"}
    h.update(extra)
    return h


def get_current_revision(url: str, key: str, drawer_id: str) -> int:
    resp = requests.get(
        f"{url}/rest/v1/drawer?id=eq.{drawer_id}&select=current_revision",
        headers=headers(key), timeout=30,
    )
    if resp.status_code != 200:
        sys.exit(f"ERROR: could not read drawer (HTTP {resp.status_code}): {resp.text}")
    rows = resp.json()
    if not rows:
        sys.exit(f"ERROR: no drawer with id {drawer_id}")
    return int(rows[0].get("current_revision") or 0)


def upload_object(url: str, key: str, local_path: str, object_path: str, content_type: str) -> str:
    """Upload a file to a versioned bucket path; return its public URL."""
    endpoint = f"{url}/storage/v1/object/{BUCKET}/{object_path}"
    with open(local_path, "rb") as f:
        data = f.read()
    # x-upsert true so re-running the same revision is safe; new revisions use new paths.
    resp = requests.post(
        endpoint,
        headers=headers(key, **{"Content-Type": content_type, "x-upsert": "true"}),
        data=data, timeout=60,
    )
    if resp.status_code not in (200, 201):
        sys.exit(f"ERROR: upload failed for {object_path} (HTTP {resp.status_code}): {resp.text}")
    public_url = f"{url}/storage/v1/object/public/{BUCKET}/{object_path}"
    print(f"  uploaded -> {public_url}")
    return public_url


def create_drawer(url: str, key: str, nickname: str, order_id: str | None) -> str:
    drawer_id = str(uuid.uuid4())
    row = {"id": drawer_id, "nickname": nickname,
           "status": "processed_by_tidydesk", "customer_approval_status": "pending"}
    if order_id:
        row["order_id"] = order_id
    resp = requests.post(
        f"{url}/rest/v1/drawer",
        headers=headers(key, **{"Content-Type": "application/json", "Prefer": "return=minimal"}),
        json=row, timeout=30,
    )
    if resp.status_code not in (200, 201, 204):
        sys.exit(f"ERROR: create drawer failed (HTTP {resp.status_code}): {resp.text}")
    print(f"  created drawer {drawer_id} ('{nickname}')")
    return drawer_id


def log_revision(url: str, key: str, drawer_id: str, preview_url: str,
                 dxf_url: str | None, note: str | None) -> dict:
    """Call the staff RPC: bumps revision, sets URLs, resets to pending, appends event."""
    resp = requests.post(
        f"{url}/rest/v1/rpc/log_design_revision",
        headers=headers(key, **{"Content-Type": "application/json"}),
        json={"p_drawer_id": drawer_id, "p_preview_url": preview_url,
              "p_dxf_url": dxf_url, "p_note": note},
        timeout=30,
    )
    if resp.status_code not in (200, 201):
        sys.exit(f"ERROR: log_design_revision failed (HTTP {resp.status_code}): {resp.text}")
    return resp.json()


def main() -> None:
    p = argparse.ArgumentParser(description="Render a DXF, version-store it, and log a design revision for customer approval.")
    p.add_argument("--dxf", required=True, help="Path to the .dxf design file")
    p.add_argument("--drawer-id", help="Existing drawer UUID")
    p.add_argument("--create", action="store_true", help="Create a new drawer instead of --drawer-id")
    p.add_argument("--nickname", help="Nickname for the new drawer (required with --create)")
    p.add_argument("--order-id", help="Optional order UUID to link a new drawer to")
    p.add_argument("--note", help="Optional revision note for the changelog")
    p.add_argument("--dpi", type=int, default=120, help="Render resolution (default 120)")
    p.add_argument("--no-dxf-upload", action="store_true", help="Skip uploading the source DXF")
    args = p.parse_args()

    if not args.create and not args.drawer_id:
        sys.exit("ERROR: pass --drawer-id <uuid> (existing) or --create --nickname \"...\" (new).")
    if args.create and not args.nickname:
        sys.exit("ERROR: --create requires --nickname.")

    url = env("SUPABASE_URL").rstrip("/")
    key = env("SUPABASE_SERVICE_ROLE_KEY")

    print("1/5  Rendering preview…")
    tmp_png = os.path.join(os.path.dirname(os.path.abspath(args.dxf)), "_preview_tmp.png")
    render_png(args.dxf, tmp_png, dpi=args.dpi)

    if args.create:
        print("2/5  Creating drawer…")
        drawer_id = create_drawer(url, key, args.nickname, args.order_id)
    else:
        drawer_id = args.drawer_id
        print(f"2/5  Using existing drawer {drawer_id}")

    next_rev = get_current_revision(url, key, drawer_id) + 1
    base_path = f"{PREVIEW_PREFIX}/{drawer_id}/rev-{next_rev}"
    print(f"3/5  Uploading revision {next_rev}…")
    preview_url = upload_object(url, key, tmp_png, f"{base_path}.png", "image/png")
    dxf_url = None
    if not args.no_dxf_upload:
        dxf_url = upload_object(url, key, args.dxf, f"{base_path}.dxf", "application/dxf")

    print("4/5  Logging revision to changelog…")
    result = log_revision(url, key, drawer_id, preview_url, dxf_url, args.note)

    print("5/5  Cleaning up…")
    try:
        os.remove(tmp_png)
    except OSError:
        pass

    print(f"\nDone — logged {result.get('event')} (revision {result.get('revision')}).")
    print("Drawer is now PENDING approval. Send this link to the customer:")
    print(f"  {APPROVE_BASE}{drawer_id}")


if __name__ == "__main__":
    main()
