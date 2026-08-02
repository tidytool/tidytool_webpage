import { SUPABASE_URL } from "@/lib/supabase/config";

/**
 * drawer.dxf_url is staff-written free text (record_dxf_upload only checks
 * non-empty), so prod holds a mix of full public storage URLs and bare
 * storage paths like "a37618a0-…/pillow_block_design.dxf". Normalize both to
 * a fetchable URL on the public `drawer-assets` bucket, or null when unset.
 */
export function dxfPublicUrl(raw: string | null | undefined): string | null {
  const s = raw?.trim();
  if (!s) return null;
  if (/^https?:\/\//i.test(s)) return s;
  const path = s.replace(/^\/+/, "").replace(/^drawer-assets\//, "");
  const encoded = path.split("/").map(encodeURIComponent).join("/");
  return `${SUPABASE_URL}/storage/v1/object/public/drawer-assets/${encoded}`;
}

/**
 * Human-useful, filesystem-safe zip entry name for a drawer's DXF:
 * sanitized nickname (fallback drawer-<id8>) + ".dxf", deduped against
 * `used` with a -2/-3… suffix. Mutates `used` by adding the chosen name.
 */
export function dxfZipEntryName(
  nickname: string | null | undefined,
  id: string,
  used: Set<string>,
): string {
  const cleaned = (nickname ?? "")
    .replace(/[^A-Za-z0-9._ -]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  const base = cleaned || `drawer-${id.slice(0, 8)}`;
  let name = `${base}.dxf`;
  for (let i = 2; used.has(name); i++) name = `${base}-${i}.dxf`;
  used.add(name);
  return name;
}
