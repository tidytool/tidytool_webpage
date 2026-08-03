// notify — customer lifecycle emails via Resend (ARCHITECTURE.md §3)
//
// Invoked server-side only: the DB helper `_notify_customer_email` posts here
// via pg_net with an `x-notify-secret` header. verify_jwt is OFF because the
// caller is Postgres, not a user; auth is the shared secret below.
//
// Secrets (Edge Functions → notify → Secrets):
//   RESEND_API_KEY      — required to actually send; missing → graceful no-op
//   NOTIFY_HOOK_SECRET  — required; must match the Vault secret `notify_hook_secret`
// Optional:
//   NOTIFY_FROM         — default "TidyTool <no-reply@thetidytool.com>"
//   NOTIFY_REPLY_TO     — default "samochristensen@gmail.com"
//   NOTIFY_OWNER        — internal-notification inbox (labels_submitted);
//                         default NOTIFY_REPLY_TO
//
// Types: design_ready / approved email the CUSTOMER (`to` from the payload).
// labels_submitted is INTERNAL-ONLY — it ignores payload `to` and emails the
// owner (customer decision 2026-08-03: no automated customer emails for the
// label flow; Sam just needs to know labels arrived).

import "jsr:@supabase/functions-js/edge-runtime.d.ts";

type Payload = {
  type: "design_ready" | "approved" | "labels_submitted";
  to: string;
  customer_name?: string;
  nickname?: string;
  drawer_id: string;
  revision?: number;
  note?: string;
};

const esc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

function render(p: Payload): { subject: string; html: string } {
  const name = p.customer_name?.trim() ? esc(p.customer_name.trim()) : "there";
  const drawer = p.nickname?.trim() ? esc(p.nickname.trim()) : "your drawer";
  const approveUrl = `https://www.thetidytool.com/approve/?id=${encodeURIComponent(p.drawer_id)}`;
  const portalUrl = "https://app.thetidytool.com";
  const note = p.note?.trim()
    ? `<p style="margin:0 0 16px;padding:12px 16px;background:#EFF2F5;border-radius:10px;color:#4A5860;">${esc(p.note.trim())}</p>`
    : "";

  const body =
    p.type === "design_ready"
      ? {
          subject: `Your TidyTool design is ready — ${p.nickname?.trim() || "review & approve"}`,
          heading: "Your foam design is ready for review",
          intro: `Hi ${name}, the design for <strong>${drawer}</strong>${p.revision && p.revision > 1 ? ` (revision ${p.revision})` : ""} is ready. Take a look and approve it — or request changes — and we'll get cutting.`,
          cta: "Review &amp; approve your design",
          ctaUrl: approveUrl,
          footer: "Nothing gets cut until you approve it.",
        }
      : p.type === "labels_submitted"
        ? {
            subject: `Labels submitted — ${p.nickname?.trim() || p.drawer_id}`,
            heading: "A customer submitted tool labels",
            intro: `${name} submitted labels for <strong>${drawer}</strong>${p.note?.trim() ? "" : "."} Review them before export.`,
            cta: "Open the label sheet",
            ctaUrl: `https://app.thetidytool.com/labels/${encodeURIComponent(p.drawer_id)}`,
            footer: "Internal notification — the customer was not emailed.",
          }
        : {
          subject: `Design approved — ${p.nickname?.trim() || "we're cutting"}`,
          heading: "Approved — we're cutting",
          intro: `Hi ${name}, thanks for signing off on <strong>${drawer}</strong>. It's headed to the CNC. We'll be in touch when it ships.`,
          cta: "View your orders",
          ctaUrl: portalUrl,
          footer: "Questions? Just reply to this email.",
        };

  const html = `<!doctype html><html><body style="margin:0;padding:0;background:#F7F8FA;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#F7F8FA;padding:32px 16px;">
<tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#FFFFFF;border:1px solid #DDE3E8;border-radius:14px;overflow:hidden;font-family:Inter,system-ui,-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
<tr><td style="background:#1E2A33;padding:20px 32px;">
  <span style="color:#FFFFFF;font-size:18px;font-weight:700;letter-spacing:.02em;">Tidy<span style="color:#E8312A;">Tool</span></span>
</td></tr>
<tr><td style="padding:32px;">
  <h1 style="margin:0 0 12px;font-size:22px;line-height:1.3;color:#1E2A33;">${body.heading}</h1>
  <p style="margin:0 0 16px;font-size:15px;line-height:1.6;color:#4A5860;">${body.intro}</p>
  ${note}
  <table role="presentation" cellpadding="0" cellspacing="0" style="margin:8px 0 20px;"><tr><td style="background:#E8312A;border-radius:10px;">
    <a href="${body.ctaUrl}" style="display:inline-block;padding:13px 26px;color:#FFFFFF;font-size:15px;font-weight:600;text-decoration:none;">${body.cta}</a>
  </td></tr></table>
  <p style="margin:0;font-size:13px;color:#4A5860;">${body.footer}</p>
</td></tr>
<tr><td style="padding:16px 32px;border-top:1px solid #DDE3E8;">
  <p style="margin:0;font-size:12px;color:#4A5860;">TidyTool — custom CNC-cut foam tool organizers · <a href="https://www.thetidytool.com" style="color:#4A5860;">thetidytool.com</a></p>
</td></tr>
</table>
</td></tr></table>
</body></html>`;

  return { subject: body.subject, html };
}

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") {
    return new Response("Method not allowed", { status: 405 });
  }

  const hookSecret = Deno.env.get("NOTIFY_HOOK_SECRET");
  if (!hookSecret || req.headers.get("x-notify-secret") !== hookSecret) {
    return new Response(JSON.stringify({ error: "unauthorized" }), {
      status: 401,
      headers: { "Content-Type": "application/json" },
    });
  }

  let p: Payload;
  try {
    p = await req.json();
  } catch {
    return new Response(JSON.stringify({ error: "invalid json" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  if (!p?.drawer_id || !["design_ready", "approved", "labels_submitted"].includes(p?.type)) {
    return new Response(JSON.stringify({ error: "invalid payload" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  // labels_submitted is internal-only: the recipient is ALWAYS the owner
  // inbox, never whatever the payload carries. Other types require `to`.
  if (p.type === "labels_submitted") {
    p.to =
      Deno.env.get("NOTIFY_OWNER") ??
      Deno.env.get("NOTIFY_REPLY_TO") ??
      "samochristensen@gmail.com";
  } else if (!p.to) {
    return new Response(JSON.stringify({ error: "invalid payload" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  const apiKey = Deno.env.get("RESEND_API_KEY");
  if (!apiKey) {
    // Graceful no-op until Sam configures Resend — mirrors the Discord pattern.
    return new Response(JSON.stringify({ ok: true, skipped: "RESEND_API_KEY not set" }), {
      headers: { "Content-Type": "application/json" },
    });
  }

  const { subject, html } = render(p);
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: Deno.env.get("NOTIFY_FROM") ?? "TidyTool <no-reply@thetidytool.com>",
      to: [p.to],
      reply_to: Deno.env.get("NOTIFY_REPLY_TO") ?? "samochristensen@gmail.com",
      subject,
      html,
    }),
  });

  const detail = await res.text();
  if (!res.ok) {
    console.error("resend error", res.status, detail);
    return new Response(JSON.stringify({ ok: false, status: res.status, detail }), {
      status: 502,
      headers: { "Content-Type": "application/json" },
    });
  }
  return new Response(JSON.stringify({ ok: true }), {
    headers: { "Content-Type": "application/json" },
  });
});
