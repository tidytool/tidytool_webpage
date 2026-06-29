// Central place to resolve Supabase connection values.
// Prefer the modern publishable key (sb_publishable_...); fall back to the legacy
// anon JWT key so existing setups keep working. Both are public / RLS-bounded.

export const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;

export const SUPABASE_KEY =
  process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ??
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
