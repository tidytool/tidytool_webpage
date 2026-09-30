import { SUPABASE_URL } from "@/lib/supabase/config";

/**
 * Dashboard thumbnails via Supabase Storage image transforms.
 *
 * drawer.photo_url is the full 2048px scan (~6 MB). The dashboard shows it at
 * 64×48, so ask Storage's render endpoint for a cover-cropped WebP (~5 KB).
 * Only public-bucket object URLs on our own project are rewritten; anything
 * else is returned untouched so a foreign URL still shows something.
 */
export function thumbUrl(photoUrl: string, width = 160, height = 120): string {
  const marker = "/storage/v1/object/public/";
  const i = photoUrl.indexOf(marker);
  if (i < 0 || !photoUrl.startsWith(SUPABASE_URL)) return photoUrl;
  const path = photoUrl.slice(i + marker.length);
  return `${SUPABASE_URL}/storage/v1/render/image/public/${path}?width=${width}&height=${height}&resize=cover&quality=50`;
}
