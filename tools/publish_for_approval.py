#!/usr/bin/env python3
"""
publish_for_approval.py — Manually publish a design for customer approval.

This is the command-line equivalent of tidyCAD's "Send for Approval" button.
Use it when you're not working inside tidyCAD — e.g. a hand-made design, or a
quick (re)publish from any machine. It takes a design file, attaches a
customer-facing preview to a drawer, records a versioned revision in the change
log, sets the drawer to "pending approval", and prints the link you send to your
customer.

Accepts either (or both):
  * a DXF        -> rendered to a preview image, and stored as the revision's DXF snapshot
  * a PNG/JPG    -> used directly as the preview (e.g. a photo or an externally rendered design)

Everything is stored at a versioned path so revisions never overwrite each other:
    approvals/{drawer_id}/rev-{n}.<png|jpg>
    approvals/{drawer_id}/rev-{n}.dxf

It runs on YOUR machine with the SERVICE ROLE key (never the anon key, never in
the website). The bucket is public-read, so the preview renders directly in the
approval page.

------------------------------------------------------------------------------
Setup (once):
    cd tools
    python3 -m venv .venv
    source .venv/bin/activate            # Windows: .venv\Scripts\activate
    pip install -r requirements.txt

Credentials (export in your shell, or put in an uncommitted .env):
    export SUPABASE_URL="https://tkrrvpoupekrjqditupi.supabase.co"
    export SUPABASE_SERVICE_ROLE_KEY="<service_role key from the Supabase dashboard>"

Usage:
    # Publish a DXF to an existing drawer (created by tidyCAM):
    python publish_for_approval.py --dxf ./design.dxf --drawer-id <uuid>

    # Publish a ready-made image (photo or rendered design) to a new drawer:
    python publish_for_approval.py --image ./design.png --create --nickname "BTECH Capstone"

    # Both: use the image as the preview AND attach the DXF snapshot:
    python publish_for_approval.py --image ./design.png --dxf ./design.dxf --drawer-id <uuid>

    # Optional: --note "Revised pocket layout"   --order-id <uuid>   --dpi 150
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

IMAGE_CONTENT_TYPES = {".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg"}


def env(name: str) -> str:
    val = os.environ.get(name)
    if not val:
        sys.exit(f"ERROR: environment variable {name} is not set. See the header of this script.")
    return val


def render_dxf_to_png(dxf_path: str, dpi: int = 120) -> bytes:
    """Render a DXF's modelspace to PNG bytes (the customer-facing preview)."""
    try:
        import io
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
    try:
        Frontend(RenderContext(doc), MatplotlibBackend(ax)).draw_layout(msp, finalize=True)
        buf = io.BytesIO()
        fig.savefig(buf, dpi=dpi, format="png", bbox_inches="tight", pad_inches=0.1)
        data = buf.getvalue()
    finally:
        plt.close(fig)

    size_kb = len(data) / 1024
    print(f"  rendered preview ({size_kb:.0f} KB)")
    if size_kb > 400:
        print("  NOTE: preview >400 KB. Consider a lower --dpi for faster mobile load.")
    return data


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


def upload_object(url: str, key: str, data: bytes, object_path: str, content_type: str) -> str:
    """Upload a file to a versioned bucket path; return its public URL."""
    endpoint = f"{url}/storage/v1/object/{BUCKET}/{object_path}"
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
    """Call the staff RPC: bumps revision, sets URLs, resets to pending, appends a change-log event."""
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
    p = argparse.ArgumentParser(
        description="Manually publish a design (DXF and/or image) to a drawer for customer approval.")
    p.add_argument("--dxf", help="Path to a .dxf design file (rendered to a preview; stored as the DXF snapshot)")
    p.add_argument("--image", help="Path to a ready-made preview image (.png/.jpg) to use directly")
    p.add_argument("--drawer-id", help="Existing drawer UUID")
    p.add_argument("--create", action="store_true", help="Create a new drawer instead of --drawer-id")
    p.add_argument("--nickname", help="Nickname for the new drawer (required with --create)")
    p.add_argument("--order-id", help="Optional order UUID to link a new drawer to")
    p.add_argument("--note", help="Optional revision note shown in the change log")
    p.add_argument("--dpi", type=int, default=120, help="Render resolution for DXF previews (default 120)")
    args = p.parse_args()

    if not args.dxf and not args.image:
        sys.exit("ERROR: provide a design with --dxf and/or --image.")
    if not args.create and not args.drawer_id:
        sys.exit("ERROR: target a drawer with --drawer-id <uuid> (existing) or --create --nickname \"...\" (new).")
    if args.create and not args.nickname:
        sys.exit("ERROR: --create requires --nickname.")

    url = env("SUPABASE_URL").rstrip("/")
    key = env("SUPABASE_SERVICE_ROLE_KEY")

    # 1) Build the preview bytes (image wins as the preview; otherwise render the DXF)
    print("1/5  Preparing preview...")
    if args.image:
        if not os.path.isfile(args.image):
            sys.exit(f"ERROR: image not found: {args.image}")
        ext = os.path.splitext(args.image)[1].lower()
        if ext not in IMAGE_CONTENT_TYPES:
            sys.exit(f"ERROR: unsupported image type '{ext}'. Use .png/.jpg/.jpeg.")
        with open(args.image, "rb") as f:
            preview_bytes = f.read()
        preview_ext, preview_ct = ext, IMAGE_CONTENT_TYPES[ext]
        print(f"  using image preview ({len(preview_bytes)/1024:.0f} KB)")
    else:
        preview_bytes = render_dxf_to_png(args.dxf, dpi=args.dpi)
        preview_ext, preview_ct = ".png", "image/png"

    dxf_bytes = None
    if args.dxf:
        if not os.path.isfile(args.dxf):
            sys.exit(f"ERROR: DXF not found: {args.dxf}")
        with open(args.dxf, "rb") as f:
            dxf_bytes = f.read()

    # 2) Resolve the drawer
    if args.create:
        print("2/5  Creating drawer...")
        drawer_id = create_drawer(url, key, args.nickname, args.order_id)
    else:
        drawer_id = args.drawer_id
        print(f"2/5  Using existing drawer {drawer_id}")

    # 3) Upload versioned assets
    next_rev = get_current_revision(url, key, drawer_id) + 1
    base = f"{PREVIEW_PREFIX}/{drawer_id}/rev-{next_rev}"
    print(f"3/5  Uploading revision {next_rev}...")
    preview_url = upload_object(url, key, preview_bytes, f"{base}{preview_ext}", preview_ct)
    dxf_url = None
    if dxf_bytes is not None:
        dxf_url = upload_object(url, key, dxf_bytes, f"{base}.dxf", "application/dxf")

    # 4) Log the revision (sets the drawer to pending + appends change-log event)
    print("4/5  Logging revision to the change log...")
    result = log_revision(url, key, drawer_id, preview_url, dxf_url, args.note)

    # 5) Done
    print("5/5  Done.")
    print(f"\nPublished {result.get('event')} (revision {result.get('revision')}). "
          f"Drawer is now PENDING approval.")
    print("Send this link to the customer:")
    print(f"  {APPROVE_BASE}{drawer_id}")


if __name__ == "__main__":
    main()
