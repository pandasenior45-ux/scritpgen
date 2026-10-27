// ScriptGen AI - Vercel server function. Keep Gemini credentials in Vercel Environment Variables only.

// Gemini Interactions API (the current API). Flash = fast and cheap; Argon only as last resort (paid, slower).
const API = 'https://generativelanguage.googleapis.com/v1beta/interactions';
const MODELS = ['gemini-3.8-flash', 'gemini-3.6-flash', 'gemini-flash-latest', 'gemini-3.5-flash', 'gemini-4-argon'];
const SCHEMA = {
  type: 'object',
  properties: {
    script: { type: 'string' },
    advantages: { type: 'array', items: { type: 'string' } },
    disadvantages: { type: 'array', items: { type: 'string' } },
    recommendations: { type: 'array', items: { type: 'string' } },
  },
  required: ['script', 'advantages', 'disadvantages', 'recommendations'],
};
const LANGUAGES = ['English', 'Spanish', 'French', 'German', 'Chinese', 'Japanese', 'Hindi', 'Urdu', 'Roman English'];
const TONES = ['Professional', 'Casual', 'Inspirational', 'Educational', 'Persuasive'];
const AUDIENCES = ['General', 'Technical', 'Business', 'Academic', 'Creative'];

const hits = new Map(); // best-effort per-IP rate limit for generation starts
const LIMIT = 10, WINDOW_MS = 10 * 60 * 1000;

const json = (payload, status = 200) => new Response(JSON.stringify(payload), {
  status,
  headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
});
const fail = (status, message) => json({ error: { message } }, status);

function interactionText(interaction) {
  if (!interaction || typeof interaction !== 'object') return '';
  if (typeof interaction.output_text === 'string' && interaction.output_text.trim()) return interaction.output_text;
  if (typeof interaction.output === 'string' && interaction.output.trim()) return interaction.output;
  const steps = Array.isArray(interaction.steps) ? interaction.steps : [];
  return steps
    .filter((step) => step && (step.type === 'model_output' || step.type === 'text'))
    .flatMap((step) => Array.isArray(step.content) ? step.content : [])
    .filter((part) => part && part.type === 'text' && typeof part.text === 'string')
    .map((part) => part.text)
    .join('');
}

function allowedOrigin(req) {
  const origin = req.headers.get('origin');
  const host = req.headers.get('x-forwarded-host') || req.headers.get('host') || new URL(req.url).host;
  try { return Boolean(origin) && new URL(origin).host === host; } catch { return false; }
}

function getKey() {
  // Configure GEMINI_API_KEY in Vercel Project Settings > Environment Variables.
  // Never put a real API key in source code or frontend assets.
  return process.env.GEMINI_API_KEY || '';
}

async function startInteraction(prompt, maxTokens, key) {
  const models = [...new Set([process.env.GEMINI_MODEL, ...MODELS].filter(Boolean))];
  let last = { status: 502, message: 'The AI service is temporarily unavailable. Please try again.' };

  for (const model of models) {
    for (const withFormat of [true, false]) {
      const body = {
        model,
        input: prompt,
        background: true,
        store: true,
        generation_config: { max_output_tokens: maxTokens },
        ...(withFormat ? {
          response_format: {
            type: 'text',
            mime_type: 'application/json',
            schema: SCHEMA,
          },
        } : {}),
      };

      let response;
      try {
        response = await fetch(API, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key, 'Api-Revision': '2026-05-20' },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(10000),
        });
      } catch (error) {
        // Do not fan out to every fallback model after a network timeout; that can
        // keep a serverless invocation alive long enough to trigger its own 502/504.
        return fail(503, error && error.name === 'TimeoutError'
          ? 'Google AI took too long to start the request. Please try again.'
          : 'Could not connect to Google AI. Check your connection and try again.');
      }

      const result = await response.json().catch(() => ({}));
      if (response.ok) {
        const interaction = result.interaction || result;
        if (!interaction.id) {
          last = { status: 502, message: 'Google AI did not return a generation ID. Please try again.' };
          break;
        }
        return json({
          interactionId: interaction.id,
          status: interaction.status || 'in_progress',
          outputText: interactionText(interaction) || undefined,
          model,
        });
      }

      last = {
        status: response.status,
        message: (result.error && result.error.message) || result.message || 'The AI service rejected the request.',
      };

      // Older API configurations may reject structured JSON output; retry the same model without the schema.
      if (response.status === 400 && withFormat && !/api key|authenticat|credential/i.test(last.message)) continue;

      // A 404 generally means this model is unavailable for the current key/project;
      // try the next documented model. Transient 5xx errors should fail fast rather
      // than serially trying every model and risking a platform-level 502/504.
      if (response.status === 404) break;
      if ([500, 502, 503, 504].includes(response.status)) {
        return fail(503, 'Google AI is temporarily unavailable. Please try again in a moment. ' + last.message);
      }
      return fail(response.status === 429 ? 429 : response.status, last.message);
    }

    if (last.status !== 404) break;
  }

  const publicStatus = [400, 401, 403, 429, 404].includes(last.status) ? last.status : 503;
  return fail(publicStatus, last.message);
}

async function pollInteraction(interactionId, key) {
  if (typeof interactionId !== 'string' || interactionId.length > 300 || !/^[A-Za-z0-9_-]+$/.test(interactionId)) {
    return fail(400, 'Invalid generation ID. Please start a new generation.');
  }

  // GET status checks are safe to retry. Google can return temporary gateway errors
  // while a background interaction is still running, so don't fail the whole job at once.
  let response;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      response = await fetch(`${API}/${encodeURIComponent(interactionId)}`, {
        method: 'GET',
        headers: { 'x-goog-api-key': key, 'Api-Revision': '2026-05-20' },
        signal: AbortSignal.timeout(7000),
      });
      if (![500, 502, 503, 504].includes(response.status) || attempt === 2) break;
      try { await response.body?.cancel(); } catch {}
      await new Promise((resolve) => setTimeout(resolve, 300 * (attempt + 1)));
    } catch (error) {
      if (attempt === 2) {
        return json({ status: 'in_progress', transientError: true, retryAfterMs: 1800 });
      }
      await new Promise((resolve) => setTimeout(resolve, 300 * (attempt + 1)));
    }
  }

  if (!response) return json({ status: 'in_progress', transientError: true, retryAfterMs: 1800 });
  if ([500, 502, 503, 504].includes(response.status)) {
    // Preserve the client polling loop; the next short check can succeed without restarting generation.
    return json({ status: 'in_progress', transientError: true, retryAfterMs: 1800 });
  }

  const result = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = (result.error && result.error.message) || result.message || 'Could not retrieve the AI result.';
    return fail(response.status === 404 ? 404 : (response.status === 429 ? 429 : response.status), message);
  }

  const interaction = result.interaction || result;
  const status = interaction.status || 'in_progress';
  if (status === 'failed' || status === 'cancelled' || status === 'requires_action') {
    const details = interaction.error && (interaction.error.message || interaction.error.status)
      ? (interaction.error.message || interaction.error.status)
      : `Generation ended with status: ${status}.`;
    return json({ status, error: details }, 502);
  }

  // Some in-progress retrievals include accumulated model-output steps; forward them
  // so the existing word-count progress indicator can keep updating where available.
  const outputText = interactionText(interaction);
  if (status === 'completed' && !outputText.trim()) {
    return fail(502, 'The AI finished but returned an empty result. Please try again.');
  }
  return json({ status, outputText: outputText || undefined });
}

export async function POST(req) {
  if (req.method !== 'POST') return fail(405, 'Method not allowed');
  if (!allowedOrigin(req)) return fail(403, 'Forbidden');

  let body;
  try { body = await req.json(); } catch { return fail(400, 'Invalid request'); }

  const key = getKey();
  if (!key) return fail(500, 'The Gemini API key is not configured.');

  const action = body && body.action ? String(body.action) : 'start';
  if (action === 'poll') return pollInteraction(body.interactionId, key);
  if (action !== 'start') return fail(400, 'Unknown request action');

  const ip = (req.headers.get('x-vercel-forwarded-for') || req.headers.get('x-forwarded-for') || 'unknown').split(',')[0].trim();
  const now = Date.now();
  const recent = (hits.get(ip) || []).filter((time) => now - time < WINDOW_MS);
  if (recent.length >= LIMIT) return fail(429, 'Too many new generations. Please wait a few minutes and try again.');
  recent.push(now);
  hits.set(ip, recent);
  if (hits.size > 5000) hits.clear();

  const topic = String((body && body.topic) || '').trim().slice(0, 300);
  if (!topic) return fail(400, 'Topic is required');
  const duration = Math.min(120, Math.max(1, parseInt(body.duration, 10) || 10));
  const language = LANGUAGES.includes(body.language) ? body.language : 'English';
  const tone = TONES.includes(body.tone) ? body.tone : 'Professional';
  const targetAudience = AUDIENCES.includes(body.targetAudience) ? body.targetAudience : 'General';

  const languageGuidance = language === 'Urdu'
    ? 'Write fluent, natural Pakistani Urdu in the Urdu script (اردو رسم الخط). Do NOT write Roman Urdu. Use clear, conversational wording that sounds natural when spoken aloud; retain technical terms or proper names only when translating them would be awkward.'
    : language === 'Roman English'
      ? 'Write fluent, natural Pakistani Urdu in Roman Urdu, using ONLY the Latin/English alphabet. This option means Urdu language written with English letters, NOT English translation. Do NOT use Urdu/Arabic script or Devanagari. Use consistent, easy-to-read Roman Urdu spellings and natural spoken phrasing; retain common English technical terms and proper names where natural.'
      : language === 'Hindi'
        ? 'Write fluent, natural Hindi in Devanagari (देवनागरी). Do NOT write Romanized Hindi. Use clear, conversational wording that sounds natural when spoken aloud; retain technical terms or proper names only when translating them would be awkward.'
        : `Write in fluent, idiomatic ${language}. Use natural phrasing for spoken delivery.`;

  const prompt = `You are a senior scriptwriter, subject-matter researcher, and demanding editorial reviewer. Create a publish-ready script and a genuinely useful analysis. The quality must be specific, engaging, well-structured, and free of filler.

BRIEF
Topic: ${topic}
Target duration: ${duration} minutes (aim for approximately ${duration * 140} spoken words; stay close to the requested duration without padding)
Language: ${language}
Tone: ${tone}
Target audience: ${targetAudience}
Language rules: ${languageGuidance}

SCRIPT QUALITY REQUIREMENTS
1. NON-NEGOTIABLE STRONG HOOK: The very first spoken sentence MUST be a powerful, highly specific, curiosity-building hook about this exact topic. It must grab attention immediately in the first 3-5 seconds using a surprising but truthful angle, a sharp question, a vivid scene, a meaningful contradiction, or a compelling verified detail. Make viewers feel they need to hear what comes next. Do not use a generic hook that could fit another topic, and never invent facts or exaggerate just to sound shocking.
2. Start the script directly with that hook. Do NOT begin with greetings, channel introductions, "welcome back", "in this video", "today we will discuss", a definition, or a slow background explanation. After the hook, quickly create an open loop or clear reason to keep watching, then move naturally into the story/explanation. Do not label the opening with words like "HOOK:".
3. Make the script feel like one coherent, professionally edited piece. Establish the context quickly, develop ideas in a logical order, use smooth transitions, maintain curiosity and momentum throughout, and finish with a memorable conclusion that answers the central question or delivers a clear takeaway.
4. Go beyond surface-level statements. Explain the important details, causes, consequences, trade-offs, and practical meaning. Add concrete examples or scenarios where they genuinely clarify the topic.
5. Match vocabulary, depth, pacing, and examples to the selected tone and target audience. Keep sentences easy to understand when read aloud and make the writing sound natural in the selected language/script.
6. Be precise and intellectually honest. Do not fabricate statistics, quotations, studies, sources, events, or claims. Where a detail is uncertain or disputed, make that clear instead of presenting a guess as fact.
7. Remove generic introductions, repetitive points, empty motivational lines, unnecessary headings, stage directions, and meta-comments about being an AI. Do not repeat the same idea to increase length.
8. Return a complete script, not an outline, summary, or list of talking points. The script should be ready for voice-over or presentation.
9. FINAL HOOK CHECK: Before returning the JSON, silently review the first sentence. If it is not instantly engaging, topic-specific, clear, and truthful, rewrite it. The script must ALWAYS open with a strong hook, regardless of selected language, tone, audience, or duration.

ANALYSIS QUALITY REQUIREMENTS
- Give exactly 3 advantages, 3 disadvantages, and 3 recommendations.
- Every point must be distinct, concrete, and directly relevant to this topic; avoid generic statements that could fit any topic.
- Advantages and disadvantages must explain meaningful benefits and real limitations or risks, not simply praise or criticize.
- Recommendations must be practical and prioritized, with clear next steps or useful ways to improve the outcome.
- Do not invent facts in the analysis. Keep all analysis in the requested language.

OUTPUT RULES
Return valid JSON only, with exactly these four keys and no markdown fences or text outside the JSON:
{"script":"complete script; use \n\n between paragraphs","advantages":["specific point 1","specific point 2","specific point 3"],"disadvantages":["specific point 1","specific point 2","specific point 3"],"recommendations":["actionable point 1","actionable point 2","actionable point 3"]}
Write every value in ${language}, following the language rules above. Make the script and all nine analysis points complete and substantive.`;


  const maxTokens = Math.min(32768, 6000 + duration * 500);
  return startInteraction(prompt, maxTokens, key);
}
