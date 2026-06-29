import { type EmailOtpType } from "@supabase/supabase-js";
import { type NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

/**
 * Auth callback. Handles BOTH email-link shapes so login works regardless of
 * whether the Supabase email templates have been customized yet:
 *
 *  - token_hash + type  -> the recommended server-side flow (edited template:
 *      {{ .SiteURL }}/auth/confirm?token_hash={{ .TokenHash }}&type=email)
 *  - code               -> the default PKCE flow (unedited template redirects
 *      back here with ?code=...)
 *
 * Either way we establish the session cookies, then redirect to `next`.
 */
export async function GET(request: NextRequest) {
  const { searchParams, origin } = new URL(request.url);
  const token_hash = searchParams.get("token_hash");
  const type = searchParams.get("type") as EmailOtpType | null;
  const code = searchParams.get("code");
  const next = searchParams.get("next") ?? "/";

  const supabase = await createClient();

  if (token_hash && type) {
    const { error } = await supabase.auth.verifyOtp({ type, token_hash });
    if (!error) return NextResponse.redirect(new URL(next, origin));
  } else if (code) {
    const { error } = await supabase.auth.exchangeCodeForSession(code);
    if (!error) return NextResponse.redirect(new URL(next, origin));
  }

  return NextResponse.redirect(new URL("/login?error=link", origin));
}
