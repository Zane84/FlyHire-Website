// FlyHire — post-tweet Edge Function
//
// Posts a saved Twitter/X thread (from public.content_pieces) to X as a chain of
// replies, using OAuth 1.0a user-context auth (your own app + access tokens).
//
// Deploy with verify_jwt = true; also re-checks the caller is the owner.
//
// Required Edge Function secrets (from developer.x.com → your app → Keys & tokens):
//   X_API_KEY         – API Key (a.k.a. Consumer Key)
//   X_API_SECRET      – API Key Secret (Consumer Secret)
//   X_ACCESS_TOKEN    – Access Token (with Read AND Write permissions)
//   X_ACCESS_SECRET   – Access Token Secret
// Auto-injected by Supabase: SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY
// Optional: OWNER_EMAIL (default "zanehaug@gmail.com")

import { createClient } from "jsr:@supabase/supabase-js@2";

const X_API_KEY = Deno.env.get("X_API_KEY") ?? "";
const X_API_SECRET = Deno.env.get("X_API_SECRET") ?? "";
const X_ACCESS_TOKEN = Deno.env.get("X_ACCESS_TOKEN") ?? "";
const X_ACCESS_SECRET = Deno.env.get("X_ACCESS_SECRET") ?? "";
const OWNER_EMAIL = (Deno.env.get("OWNER_EMAIL") ?? "zanehaug@gmail.com").toLowerCase();

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// --- OAuth 1.0a (HMAC-SHA1) -------------------------------------------------
const pe = (s: string) =>
  encodeURIComponent(s).replace(/[!*'()]/g, (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase());

async function hmacSha1Base64(key: string, msg: string): Promise<string> {
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(key),
    { name: "HMAC", hash: "SHA-1" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", cryptoKey, new TextEncoder().encode(msg));
  return btoa(String.fromCharCode(...new Uint8Array(sig)));
}

async function oauthHeader(method: string, url: string): Promise<string> {
  const oauth: Record<string, string> = {
    oauth_consumer_key: X_API_KEY,
    oauth_nonce: crypto.randomUUID().replace(/-/g, ""),
    oauth_signature_method: "HMAC-SHA1",
    oauth_timestamp: Math.floor(Date.now() / 1000).toString(),
    oauth_token: X_ACCESS_TOKEN,
    oauth_version: "1.0",
  };
  // Signature base string (JSON body is NOT included for v2 endpoints)
  const paramStr = Object.keys(oauth).sort()
    .map((k) => `${pe(k)}=${pe(oauth[k])}`).join("&");
  const base = `${method.toUpperCase()}&${pe(url)}&${pe(paramStr)}`;
  const signingKey = `${pe(X_API_SECRET)}&${pe(X_ACCESS_SECRET)}`;
  oauth.oauth_signature = await hmacSha1Base64(signingKey, base);

  return "OAuth " + Object.keys(oauth).sort()
    .map((k) => `${pe(k)}="${pe(oauth[k])}"`).join(", ");
}

async function postTweet(text: string, replyToId?: string): Promise<string> {
  const url = "https://api.twitter.com/2/tweets";
  const payload: Record<string, unknown> = { text };
  if (replyToId) payload.reply = { in_reply_to_tweet_id: replyToId };

  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: await oauthHeader("POST", url),
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });
  const bodyText = await res.text();
  if (!res.ok) {
    console.error("X API error", res.status, bodyText);
    throw new Error(`X error ${res.status}: ${bodyText.slice(0, 300)}`);
  }
  const data = JSON.parse(bodyText);
  const id = data?.data?.id;
  if (!id) throw new Error("X did not return a tweet id.");
  return id;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ ok: false, error: "Method not allowed" }, 405);

  if (!X_API_KEY || !X_API_SECRET || !X_ACCESS_TOKEN || !X_ACCESS_SECRET) {
    return json({ ok: false, error: "X credentials are not configured yet." }, 500);
  }

  const authHeader = req.headers.get("Authorization") ?? "";
  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_ANON_KEY")!,
    { global: { headers: { Authorization: authHeader } } },
  );

  const { data: userData, error: userError } = await supabase.auth.getUser();
  const email = userData?.user?.email?.toLowerCase() ?? "";
  if (userError || !email) return json({ ok: false, error: "Not authenticated." }, 401);
  if (email !== OWNER_EMAIL) return json({ ok: false, error: "Not authorized." }, 403);

  let body: Record<string, string>;
  try { body = await req.json(); } catch { return json({ ok: false, error: "Invalid JSON" }, 400); }

  const pieceId = (body.content_piece_id ?? "").trim();
  if (!pieceId) return json({ ok: false, error: "content_piece_id is required." }, 400);

  // Read the thread (RLS scopes this to the owner).
  const { data: piece, error: readErr } = await supabase
    .from("content_pieces")
    .select("id, twitter_thread, twitter_posted_at")
    .eq("id", pieceId)
    .single();
  if (readErr || !piece) return json({ ok: false, error: "Couldn't find that content piece." }, 404);
  if (piece.twitter_posted_at) return json({ ok: false, error: "This thread was already posted." }, 409);

  const tweets: string[] = Array.isArray(piece.twitter_thread)
    ? piece.twitter_thread.filter((t: unknown) => typeof t === "string" && t.trim() !== "")
    : [];
  if (!tweets.length) return json({ ok: false, error: "There are no tweets to post." }, 400);

  const tooLong = tweets.find((t) => t.length > 280);
  if (tooLong) return json({ ok: false, error: "One tweet is over 280 characters — trim it first." }, 400);

  // Post the chain.
  let firstId = "";
  let prevId: string | undefined;
  try {
    for (const text of tweets) {
      const id = await postTweet(text, prevId);
      if (!firstId) firstId = id;
      prevId = id;
      await sleep(800); // be gentle with rate limits
    }
  } catch (e) {
    return json({ ok: false, error: (e as Error).message, posted_so_far: firstId ? true : false }, 502);
  }

  const threadUrl = `https://x.com/i/web/status/${firstId}`;
  const { error: updErr } = await supabase
    .from("content_pieces")
    .update({ twitter_posted_at: new Date().toISOString(), twitter_thread_url: threadUrl })
    .eq("id", pieceId);
  if (updErr) console.error("Failed to record post status", updErr);

  return json({ ok: true, thread_url: threadUrl });
});
