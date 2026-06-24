// FlyHire — submit-lead Edge Function
//
// Receives a contact-form submission, stores it in public.leads, and sends two
// emails via Resend: a confirmation to the prospect and a notification to Zane.
//
// Deploy with verify_jwt = false so the public form can call it without a JWT.
//
// Required Edge Function secrets:
//   RESEND_API_KEY          – your Resend API key  (set via dashboard / `supabase secrets set`)
// Automatically injected by Supabase (no action needed):
//   SUPABASE_URL
//   SUPABASE_SERVICE_ROLE_KEY
//
// Optional secrets (have sensible defaults):
//   FROM_EMAIL              – default "FlyHire Connections <hello@flyhireconnect.com>"
//   NOTIFY_EMAIL            – default "info@flyhireconnect.com"

import { createClient } from "jsr:@supabase/supabase-js@2";

const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY") ?? "";
const FROM_EMAIL = Deno.env.get("FROM_EMAIL") ?? "FlyHire Connections <hello@flyhireconnect.com>";
const NOTIFY_EMAIL = Deno.env.get("NOTIFY_EMAIL") ?? "info@flyhireconnect.com";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });

const esc = (s: string) =>
  String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");

const isEmail = (s: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s);

async function sendEmail(payload: Record<string, unknown>) {
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${RESEND_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const detail = await res.text();
    console.error("Resend error", res.status, detail);
  }
  return res.ok;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ ok: false, error: "Method not allowed" }, 405);

  let body: Record<string, string>;
  try {
    body = await req.json();
  } catch {
    return json({ ok: false, error: "Invalid JSON" }, 400);
  }

  // Honeypot: real users never fill this. Pretend success so bots don't retry.
  if (body.hp && body.hp.trim() !== "") return json({ ok: true });

  const name = (body.name ?? "").trim();
  const email = (body.email ?? "").trim();
  const company = (body.company ?? "").trim();
  const phone = (body.phone ?? "").trim();
  const revenue_range = (body.revenue_range ?? "").trim();
  const message = (body.message ?? "").trim();

  if (!name) return json({ ok: false, error: "Please enter your name." }, 400);
  if (!isEmail(email)) return json({ ok: false, error: "Please enter a valid email." }, 400);

  // 1) Store the lead (service role bypasses RLS).
  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );
  const { error: dbError } = await supabase.from("leads").insert({
    name,
    email,
    company: company || null,
    phone: phone || null,
    revenue_range: revenue_range || null,
    message: message || null,
  });
  if (dbError) {
    console.error("DB insert error", dbError);
    return json({ ok: false, error: "Could not save your request. Please try again." }, 500);
  }

  // 2) Emails. Wrapped so a Resend hiccup never loses the saved lead.
  try {
    // Confirmation to the prospect.
    await sendEmail({
      from: FROM_EMAIL,
      to: [email],
      reply_to: NOTIFY_EMAIL,
      subject: "We got your request — FlyHire Connections",
      html: `
        <div style="font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;max-width:520px;margin:0 auto;color:#1a2233;line-height:1.6">
          <p style="font-size:18px;font-weight:700;color:#0E1A33;margin:0 0 16px">Thanks, ${esc(name)} — we've got it.</p>
          <p>We received your request for a scoping call. One of us will reach out within <strong>one business day</strong> to find a time.</p>
          <p>On the call we'll tell you straight whether we can move the needle — no pitch, no pressure — and, if there's a fit, exactly which function to start with and what to expect.</p>
          <p style="margin-top:24px">Talk soon,<br/><strong>FlyHire Connections</strong></p>
          <hr style="border:none;border-top:1px solid #e5e9f0;margin:24px 0"/>
          <p style="font-size:12px;color:#8a93a6">Managed offshore operations for U.S. small businesses. One fee. One report. One SLA.</p>
        </div>`,
    });

    // Notification to Zane — reply goes straight to the prospect.
    const row = (label: string, value: string) =>
      value ? `<tr><td style="padding:4px 12px 4px 0;color:#8a93a6">${label}</td><td style="padding:4px 0"><strong>${esc(value)}</strong></td></tr>` : "";
    await sendEmail({
      from: FROM_EMAIL,
      to: [NOTIFY_EMAIL],
      reply_to: email,
      subject: `🛬 New lead: ${name}${company ? ` (${company})` : ""}`,
      html: `
        <div style="font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;max-width:560px;margin:0 auto;color:#1a2233;line-height:1.6">
          <p style="font-size:18px;font-weight:700;color:#0E1A33;margin:0 0 16px">New scoping-call request</p>
          <table style="border-collapse:collapse;font-size:14px">
            ${row("Name", name)}
            ${row("Email", email)}
            ${row("Company", company)}
            ${row("Phone", phone)}
            ${row("Revenue", revenue_range)}
          </table>
          ${message ? `<p style="margin-top:16px;color:#8a93a6">Message</p><div style="background:#f5f7fb;border-radius:8px;padding:12px 14px;white-space:pre-wrap">${esc(message)}</div>` : ""}
          <p style="margin-top:20px;font-size:13px;color:#8a93a6">Reply to this email to respond directly to ${esc(name)}.</p>
        </div>`,
    });
  } catch (e) {
    console.error("Email send failed (lead was still saved)", e);
  }

  return json({ ok: true });
});
