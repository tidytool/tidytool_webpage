/**
 * Driving-distance lookup used to auto-fill an order's round-trip miles from its
 * site address, so the operator never hand-types (or mistypes) the distance.
 *
 * Provider: Google Distance Matrix (classic REST — address→address driving
 * distance in one call, no separate geocode step). Configure via env:
 *   GOOGLE_MAPS_API_KEY  — a Google Maps Platform key with Distance Matrix enabled
 *   SHOP_ORIGIN_ADDRESS  — where trips start, e.g. "700 N 1200 E, Logan, UT 84321"
 *
 * Returns ROUND-TRIP miles (one-way × 2). Never throws — returns {ok:false,error}
 * so the caller can surface a friendly message. To swap providers (e.g. Geoapify's
 * free tier), replace the fetch/parse block below; the return shape stays the same.
 */

export type DistanceResult =
  | { ok: true; round_trip_miles: number; one_way_miles: number; provider: string }
  | { ok: false; error: string };

type DistanceMatrixResponse = {
  status?: string;
  error_message?: string;
  rows?: { elements?: { status?: string; distance?: { value?: number } }[] }[];
};

const METERS_PER_MILE = 1609.344;
const round1 = (n: number) => Math.round(n * 10) / 10;

export async function lookupRoundTripMiles(destination: string): Promise<DistanceResult> {
  const dest = destination.trim();
  if (!dest) return { ok: false, error: "Enter a site address first." };

  const origin = process.env.SHOP_ORIGIN_ADDRESS?.trim();
  const key = process.env.GOOGLE_MAPS_API_KEY?.trim();
  if (!origin) return { ok: false, error: "Distance lookup isn't configured — set SHOP_ORIGIN_ADDRESS." };
  if (!key) return { ok: false, error: "Distance lookup isn't configured — set GOOGLE_MAPS_API_KEY." };

  const url =
    "https://maps.googleapis.com/maps/api/distancematrix/json" +
    `?origins=${encodeURIComponent(origin)}` +
    `&destinations=${encodeURIComponent(dest)}` +
    "&mode=driving&units=imperial" +
    `&key=${encodeURIComponent(key)}`;

  let data: DistanceMatrixResponse;
  try {
    const res = await fetch(url, { cache: "no-store" });
    data = (await res.json()) as DistanceMatrixResponse;
  } catch (e) {
    return { ok: false, error: `Distance service unreachable: ${(e as Error).message}` };
  }

  if (data.status !== "OK") {
    return { ok: false, error: `Distance lookup failed: ${data.error_message || data.status || "unknown error"}` };
  }
  const el = data.rows?.[0]?.elements?.[0];
  if (!el || el.status !== "OK" || typeof el.distance?.value !== "number") {
    return { ok: false, error: `No driving route found from the shop to "${dest}" (${el?.status ?? "no result"}).` };
  }

  const oneWay = el.distance.value / METERS_PER_MILE;
  return {
    ok: true,
    one_way_miles: round1(oneWay),
    round_trip_miles: round1(oneWay * 2),
    provider: "google-distance-matrix",
  };
}
