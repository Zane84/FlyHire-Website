// FlyHire — generate-content Edge Function
//
// The private content studio calls this to turn a source (a YouTube link or a
// text brain-dump) into three drafts: a LinkedIn post, a blog post (markdown),
// and a Twitter/X thread. The drafts are saved to public.content_pieces and
// returned to the studio for review/editing.
//
// Deploy with verify_jwt = true. On top of the platform JWT check, this function
// re-verifies the caller is the owner (Google sign-in admits any Google account,
// so "authenticated" alone is not enough — we require the owner's email).
//
// Required Edge Function secrets:
//   ANTHROPIC_API_KEY   – Anthropic API key (server-side only)
//   TRANSCRIPT_API_KEY  – Supadata API key, for YouTube transcripts
// Automatically injected by Supabase:
//   SUPABASE_URL
//   SUPABASE_ANON_KEY  (used with the caller's bearer so RLS applies)
//   SUPABASE_SERVICE_ROLE_KEY
//
// Optional secrets (have sensible defaults):
//   OWNER_EMAIL         – default "zanehaug@gmail.com"
//   GENERATE_MODEL      – default "claude-sonnet-4-6"

import { createClient } from "jsr:@supabase/supabase-js@2";

const ANTHROPIC_API_KEY = Deno.env.get("ANTHROPIC_API_KEY") ?? "";
const TRANSCRIPT_API_KEY = Deno.env.get("TRANSCRIPT_API_KEY") ?? "";
const OWNER_EMAIL = (Deno.env.get("OWNER_EMAIL") ?? "zanehaug@gmail.com").toLowerCase();
const GENERATE_MODEL = Deno.env.get("GENERATE_MODEL") ?? "claude-sonnet-4-6";

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

// --- YouTube transcript via Supadata (https://supadata.ai) ------------------
// Returns plain text. Throws with a friendly message if it can't get a transcript.
async function fetchYoutubeTranscript(url: string): Promise<string> {
  if (!TRANSCRIPT_API_KEY) {
    throw new Error("Transcript service is not configured (TRANSCRIPT_API_KEY missing).");
  }
  const endpoint = `https://api.supadata.ai/v1/transcript?url=${encodeURIComponent(url)}&text=true`;
  const res = await fetch(endpoint, { headers: { "x-api-key": TRANSCRIPT_API_KEY } });
  if (!res.ok) {
    const detail = await res.text();
    console.error("Transcript API error", res.status, detail);
    throw new Error(`Transcript error ${res.status}: ${detail.slice(0, 300)}`);
  }
  const data = await res.json();
  // Supadata returns { content: "..." } with text=true, or an array of segments.
  let text = "";
  if (typeof data?.content === "string") text = data.content;
  else if (Array.isArray(data?.content)) text = data.content.map((s: any) => s?.text ?? "").join(" ");
  else if (typeof data?.transcript === "string") text = data.transcript;
  text = text.trim();
  if (!text) throw new Error("That video didn't return any transcript text.");
  return text;
}

// --- Claude generation ------------------------------------------------------
const OUTPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    title: { type: "string", description: "A short, specific blog title (no clickbait)." },
    blog_excerpt: { type: "string", description: "1–2 sentence summary for the blog index." },
    blog_post: { type: "string", description: "The blog post in Markdown. 600–1000 words, with H2 subheads." },
    linkedin_post: { type: "string", description: "A LinkedIn post, ~150–250 words, line breaks for readability, no hashtag spam (0–3 tags max)." },
    twitter_thread: {
      type: "array",
      description: "A Twitter/X thread of 5–8 tweets. Each entry is one tweet, <= 270 characters, no leading numbering.",
      items: { type: "string" },
    },
  },
  required: ["title", "blog_excerpt", "blog_post", "linkedin_post", "twitter_thread"],
};

const SYSTEM_PROMPT = `You are the content engine for FlyHire Connections, a service that builds and runs dedicated, AI-augmented offshore operations teams for U.S. small businesses (appointment setting, CRM, inbox, follow-ups — done for you, with an SLA in writing).

Brand voice: plain-spoken, credible, specific. Accountability rendered as a document. No hype, no buzzword salad, no "in today's fast-paced world" filler, no emoji storms. Concrete numbers and outcomes over adjectives. Confident but not salesy.

You will be given a source (a transcript or a raw brain-dump). Turn its IDEAS into three publish-ready pieces of content, each tailored to its platform:
- A LinkedIn post (professional, a hook first line, a clear takeaway, light formatting).
- A blog post in Markdown (substantive, skimmable, with H2 subheads; written to live on the FlyHire site).
- A Twitter/X thread (punchy, one idea per tweet, a strong opening hook, a closing line).

Stay faithful to the source's substance; do not invent statistics. Write in FlyHire's voice. Return ONLY the structured object.`;

async function generateDrafts(sourceText: string, guidance: string) {
  const guidanceBlock = guidance
    ? `\n\nExtra guidance from the author for this piece (follow it):\n<guidance>\n${guidance}\n</guidance>`
    : "";
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: GENERATE_MODEL,
      max_tokens: 16000,
      system: SYSTEM_PROMPT,
      output_config: { format: { type: "json_schema", schema: OUTPUT_SCHEMA } },
      messages: [
        {
          role: "user",
          content: `Here is the source material. Produce the three pieces of content from it.\n\n<source>\n${sourceText}\n</source>${guidanceBlock}`,
        },
      ],
    }),
  });

  if (!res.ok) {
    const detail = await res.text();
    console.error("Anthropic error", res.status, detail);
    throw new Error(`AI error ${res.status}: ${detail.slice(0, 400)}`);
  }

  const data = await res.json();
  if (data?.stop_reason === "refusal") {
    throw new Error("The AI declined to generate from that input.");
  }
  const textBlock = (data?.content ?? []).find((b: any) => b.type === "text");
  if (!textBlock?.text) throw new Error("The AI returned an empty response.");

  let parsed: any;
  try {
    parsed = JSON.parse(textBlock.text);
  } catch {
    console.error("Could not parse AI output", textBlock.text?.slice(0, 500));
    throw new Error("The AI returned malformed output. Please try again.");
  }
  return parsed;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ ok: false, error: "Method not allowed" }, 405);

  // --- Auth: confirm the caller is the owner --------------------------------
  const authHeader = req.headers.get("Authorization") ?? "";
  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_ANON_KEY")!,
    { global: { headers: { Authorization: authHeader } } },
  );

  const { data: userData, error: userError } = await supabase.auth.getUser();
  const email = userData?.user?.email?.toLowerCase() ?? "";
  if (userError || !email) {
    return json({ ok: false, error: "Not authenticated." }, 401);
  }
  if (email !== OWNER_EMAIL) {
    return json({ ok: false, error: "Not authorized." }, 403);
  }

  // --- Input ----------------------------------------------------------------
  let body: Record<string, string>;
  try {
    body = await req.json();
  } catch {
    return json({ ok: false, error: "Invalid JSON" }, 400);
  }

  const sourceType = (body.source_type ?? "").trim();
  const sourceUrl = (body.source_url ?? "").trim();
  const rawText = (body.source_text ?? "").trim();
  const guidance = (body.guidance ?? "").trim().slice(0, 1000);

  if (sourceType !== "youtube" && sourceType !== "braindump") {
    return json({ ok: false, error: "source_type must be 'youtube' or 'braindump'." }, 400);
  }

  // --- Resolve the source text ----------------------------------------------
  let sourceText = rawText;
  try {
    if (sourceType === "youtube") {
      if (!sourceUrl) return json({ ok: false, error: "Please provide a YouTube URL." }, 400);
      sourceText = await fetchYoutubeTranscript(sourceUrl);
    } else if (!sourceText) {
      return json({ ok: false, error: "Please write something to generate from." }, 400);
    }
  } catch (e) {
    return json({ ok: false, error: (e as Error).message }, 502);
  }

  // --- Generate -------------------------------------------------------------
  let drafts: any;
  try {
    drafts = await generateDrafts(sourceText, guidance);
  } catch (e) {
    return json({ ok: false, error: (e as Error).message }, 502);
  }

  const thread = Array.isArray(drafts.twitter_thread)
    ? drafts.twitter_thread.filter((t: unknown) => typeof t === "string" && t.trim() !== "")
    : [];

  // --- Save (RLS enforces owner-only via the caller's JWT) -------------------
  const { data: inserted, error: dbError } = await supabase
    .from("content_pieces")
    .insert({
      source_type: sourceType,
      source_url: sourceType === "youtube" ? sourceUrl : null,
      source_text: sourceText,
      title: drafts.title ?? null,
      blog_excerpt: drafts.blog_excerpt ?? null,
      blog_post: drafts.blog_post ?? null,
      linkedin_post: drafts.linkedin_post ?? null,
      twitter_thread: thread,
    })
    .select()
    .single();

  if (dbError) {
    console.error("DB insert error", dbError);
    return json({ ok: false, error: "Generated, but couldn't save. Please try again." }, 500);
  }

  return json({ ok: true, piece: inserted });
});
