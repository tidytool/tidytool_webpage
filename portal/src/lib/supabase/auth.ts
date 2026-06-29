import { createClient } from "./server";

/**
 * Verified identity for the current request.
 *
 * Uses getClaims() per current Supabase SSR guidance: it validates the JWT
 * signature (locally against the project's published keys when asymmetric keys
 * are in use) rather than trusting the raw session. Returns null when there's
 * no valid session.
 */
export async function getClaims() {
  const supabase = await createClient();
  const { data } = await supabase.auth.getClaims();
  return data?.claims ?? null;
}

/** Convenience: the signed-in user's email, or undefined. */
export async function getUserEmail(): Promise<string | undefined> {
  const claims = await getClaims();
  return (claims?.email as string | undefined) ?? undefined;
}
