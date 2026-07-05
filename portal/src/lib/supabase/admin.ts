// Service-role Supabase client — SERVER ONLY. Bypasses RLS; used exclusively
// by admin server actions for auth-user management (invites, password setup).
//
// The secret key must NEVER be prefixed NEXT_PUBLIC_ (that would bundle it into
// the browser build). Callers are responsible for verifying is_admin() with the
// session-scoped client BEFORE touching this one — unlike our SECURITY DEFINER
// RPCs, nothing in the database re-checks the caller here.

import { createClient as createSupabaseClient } from "@supabase/supabase-js";
import { SUPABASE_URL } from "./config";

export function createAdminClient() {
  const secret =
    process.env.SUPABASE_SECRET_KEY ?? // modern sb_secret_... key
    process.env.SUPABASE_SERVICE_ROLE_KEY; // legacy service_role JWT
  if (!secret) {
    throw new Error(
      "Missing SUPABASE_SECRET_KEY (or SUPABASE_SERVICE_ROLE_KEY) — set it in the server environment.",
    );
  }
  return createSupabaseClient(SUPABASE_URL, secret, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}
