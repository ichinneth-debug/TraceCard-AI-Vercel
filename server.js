'use strict';

// Vercel supplies environment variables directly. Load .env only when available locally.
try { require('dotenv').config(); } catch (error) {
  if (error?.code !== 'MODULE_NOT_FOUND') throw error;
}
const express = require('express');
const path = require('path');
const IS_VERCEL = Boolean(process.env.VERCEL);
// Vercel background scheduling is optional; status polling can finish batches
// when the package or request context is unavailable.
const TC_BACKEND_VERSION = 'research-sheets-verification-1';
let backgroundWaitUntil = null;
if (IS_VERCEL) {
  try {
    const api = require('@vercel/functions');
    if (typeof api.waitUntil === 'function') backgroundWaitUntil = api.waitUntil;
  } catch {
    console.warn('[TraceCard AI] Vercel waitUntil unavailable; using status-driven recovery.');
  }
}

const app = express();
app.disable('x-powered-by');

const PORT = Number(process.env.PORT || 3000);
const PROVIDERS = [
  {
    id: 'groq',
    key: process.env.GROQ_API_KEY?.trim(),
    model: process.env.GROQ_MODEL?.trim() || 'openai/gpt-oss-20b',
  },
  {
    id: 'gemini',
    key: process.env.GEMINI_API_KEY?.trim(),
    model: process.env.GEMINI_MODEL?.trim() || 'gemini-3.6-flash',
  },
  {
    id: 'openai',
    key: process.env.OPENAI_API_KEY?.trim(),
    model: process.env.OPENAI_MODEL?.trim() || 'gpt-4.1-mini',
  },
  {
    id: 'openrouter',
    key: process.env.OPENROUTER_API_KEY?.trim(),
    model: process.env.OPENROUTER_MODEL?.trim() || 'openrouter/free',
  },
];

// Fastest configured provider first by default. Customize without code changes:
// AI_PROVIDER_ORDER=groq,gemini,openai,openrouter
const preferredProviders=(process.env.AI_PROVIDER_ORDER || 'groq,gemini,openai,openrouter')
  .toLowerCase().split(',').map(x=>x.trim()).filter(Boolean);
PROVIDERS.sort((a,b)=>{
  const ai=preferredProviders.indexOf(a.id),bi=preferredProviders.indexOf(b.id);
  return (ai<0?100:ai)-(bi<0?100:bi);
});

function boundedInteger(name, fallback, minimum, maximum) {
  const value = Number(process.env[name]);
  if (!Number.isFinite(value)) return fallback;
  return Math.max(minimum, Math.min(maximum, Math.floor(value)));
}

const MAX_ACTIVE = boundedInteger('AI_CONCURRENCY', 5, 1, 20);
const MAX_QUEUE = boundedInteger('AI_QUEUE_LIMIT', 80, 1, 500);
const MAX_QUEUE_WAIT_MS = boundedInteger('AI_QUEUE_WAIT_MS', 180000, 5000, 600000);
const PROVIDER_TIMEOUT_MS = boundedInteger('AI_TIMEOUT_MS', 25000, 5000, 120000);
const MAX_PROMPT_CHARS = boundedInteger('MAX_PROMPT_CHARS', 80000, 1000, 200000);

const CARD_TYPES = new Set(['mcq', 'identification', 'enumeration', 'fillblank']);
const FIELDS = ['type', 'question', 'answer', 'choices', 'page', 'source_excerpt'];
function requestedCardType(prompt, suppliedSchema) {
  const fromSchema = suppliedSchema?.properties?.flashcards?.items?.properties?.type?.enum;
  if (Array.isArray(fromSchema) && fromSchema.length === 1 && CARD_TYPES.has(fromSchema[0])) {
    return fromSchema[0];
  }
  const fromPrompt = String(prompt).match(/(?:^|\n)Type:\s*(mcq|identification|enumeration|fillblank)\b/i);
  return fromPrompt ? fromPrompt[1].toLowerCase() : 'mcq';
}
function buildResponseSchema(type) {
  if (!CARD_TYPES.has(type)) throw new AIError('Unsupported question type.', 400);
  const answer = type === 'enumeration'
    ? { type: 'array', items: { type: 'string' }, minItems: 2, maxItems: 5 }
    : { type: 'string' };
  const choices = type === 'mcq'
    ? { type: 'array', items: { type: 'string' }, minItems: 4, maxItems: 4 }
    : { type: 'array', items: { type: 'string' }, maxItems: 0 };
  return {
    type: 'object', additionalProperties: false,
    properties: {
      flashcards: {
        type: 'array', items: {
          type: 'object', additionalProperties: false,
          properties: {
            type: { type: 'string', enum: [type] },
            question: { type: 'string' }, answer, choices,
            page: { type: 'integer' }, source_excerpt: { type: 'string' },
          },
          required: FIELDS,
        },
      },
    },
    required: ['flashcards'],
  };
}


const cooldownUntil = new Map();
const queue = [];
let active = 0;

app.use(express.json({ limit: '2mb' }));

class AIError extends Error {
  constructor(message, status = 503) {
    super(message);
    this.status = status;
  }
}

function queueTask(task) {
  return new Promise((resolve, reject) => {
    if (queue.length >= MAX_QUEUE) {
      reject(new AIError('AI server is busy. Please try again in a moment.', 503));
      return;
    }
    queue.push({ task, resolve, reject, addedAt: Date.now() });
    runQueue();
  });
}

function runQueue() {
  while (active < MAX_ACTIVE && queue.length) {
    const job = queue.shift();
    if (Date.now() - job.addedAt > MAX_QUEUE_WAIT_MS) {
      job.reject(new AIError('Generation queue took too long. Please try again.', 503));
      continue;
    }
    active++;
    Promise.resolve()
      .then(job.task)
      .then(job.resolve, job.reject)
      .finally(() => {
        active--;
        runQueue();
      });
  }
}

// Keep strict page + 10-160 character checks, but tolerate punctuation/dash differences.
// Checking both forms handles "sodium-potassium" vs "sodium potassium" while
// rejecting excerpts that are not actually present on the referenced PDF page.
function normalizeExcerptText(value, punctuationAsSpace = false) {
  const text = String(value ?? '').normalize('NFKC').toLowerCase();
  const normalized = punctuationAsSpace
    ? text.replace(/[^\p{L}\p{N}\p{M}\s]/gu, ' ')
    : text.replace(/[^\p{L}\p{N}\p{M}\s]/gu, '');
  return normalized.replace(/\s+/g, ' ').trim();
}
function sourceExcerptOnPage(pageText, excerpt) {
  if (typeof excerpt !== 'string' || excerpt.length < 10 || excerpt.length > 160 ||
      typeof pageText !== 'string') return false;
  const plainExcerpt = normalizeExcerptText(excerpt);
  // Do not accept excerpts made of only punctuation/whitespace.
  if (plainExcerpt.replace(/\s/g, '').length < 8) return false;
  return normalizeExcerptText(pageText).includes(plainExcerpt) ||
    normalizeExcerptText(pageText, true).includes(normalizeExcerptText(excerpt, true));
}
// Validate excerpts against the matching PAGE N text in ordinary API prompts.
function quotedInSource(prompt, page, excerpt) {
  if (typeof prompt !== 'string') return true;
  const marker = /^PAGE (\d+):\s*/gm;
  const spans = [...prompt.matchAll(marker)];
  if (!spans.length) return true; // Legacy API calls without page-formatted source.
  for (let i = 0; i < spans.length; i++) {
    if (Number(spans[i][1]) !== page) continue;
    const start = spans[i].index + spans[i][0].length;
    const end = i + 1 < spans.length ? spans[i + 1].index : prompt.length;
    if (sourceExcerptOnPage(prompt.slice(start, end), excerpt)) return true;
  }
  return false;
}

function parseFlashcards(raw, requestedType = null, prompt = null, sourcePages = null) {
  let value = raw;
  if (typeof value === 'string') {
    const text = value.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
    if (!text) throw new AIError('AI response contained no text.', 502);
    try {
      value = JSON.parse(text);
    } catch {

      const locations = [text.indexOf('['), text.indexOf('{')].filter(n => n >= 0);
      const start = locations.length ? Math.min(...locations) : -1;
      const end = Math.max(text.lastIndexOf(']'), text.lastIndexOf('}'));
      if (start < 0 || end <= start) throw new AIError('Provider did not return valid flashcard JSON.', 502);
      try { value = JSON.parse(text.slice(start, end + 1)); }
      catch { throw new AIError('Provider did not return valid flashcard JSON.', 502); }
    }
  }
  const list = Array.isArray(value) ? value
    : Array.isArray(value?.flashcards) ? value.flashcards
    : Array.isArray(value?.cards) ? value.cards : null;
  if (!list?.length) throw new AIError('Provider returned no flashcards.', 502);

  // Background jobs validate against the full PDF, not just the five-page prompt window.
  const pagesByNumber = Array.isArray(sourcePages)
    ? new Map(sourcePages.map(p => [p.page, p.text])) : null;
  const reasons = { format: 0, type: 0, answer: 0, source: 0 };
  const valid = [];
  const aliases = {
    multiple_choice: 'mcq', multiplechoice: 'mcq',
    fill_in_the_blank: 'fillblank', fill_in_blank: 'fillblank',
  };
  for (const input of list) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) { reasons.format++; continue; }
    const rawType = input.type || input.question_type || input.questionType || requestedType || 'mcq';
    const type = aliases[rawType] || rawType;
    if (!CARD_TYPES.has(type) || (requestedType && type !== requestedType)) { reasons.type++; continue; }
    const question = String(input.question ?? input.q ?? '').trim();
    const excerpt = String(input.source_excerpt ?? input.sourceExcerpt ?? input.excerpt ?? '').replace(/\s+/g,' ').trim();
    const page = Number(input.page ?? input.page_number ?? input.pageNumber);
    const choiceInput = input.choices ?? input.opts ?? input.options ?? [];
    const choices = Array.isArray(choiceInput) ? choiceInput.map(x => String(x ?? '').trim()) : null;
    if (!question || !Number.isInteger(page) || page < 1 || !Array.isArray(choices)) {
      reasons.format++; continue;
    }
    const excerptValid = pagesByNumber
      ? sourceExcerptOnPage(pagesByNumber.get(page), excerpt)
      : quotedInSource(prompt, page, excerpt);
    if (excerpt.length < 10 || excerpt.length > 160 || !excerptValid) {
      reasons.source++; continue;
    }
    let answer = input.answer ?? input.a;
    if (type === 'enumeration') {
      if (typeof answer === 'string') answer = answer.split(/[;\n]+/).map(x => x.trim()).filter(Boolean);
      if (!Array.isArray(answer)) { reasons.answer++; continue; }
      answer = answer.map(x => String(x ?? '').trim()).filter(Boolean);
      if (answer.length < 2 || answer.length > 5 || new Set(answer.map(x => x.toLowerCase())).size !== answer.length || choices.length) {
        reasons.answer++; continue;
      }
    } else {
      if (typeof answer !== 'string' || !answer.trim()) { reasons.answer++; continue; }
      answer = answer.trim();
      if (type === 'mcq') {
        if (choices.length !== 4 || choices.some(x => !x) ||
            new Set(choices.map(x => x.toLowerCase())).size !== 4 ||
            !choices.some(x => x.toLowerCase() === answer.toLowerCase())) {
          reasons.answer++; continue;
        }
      } else if (choices.length || (type === 'fillblank' &&
                 ((question.match(/____/g) || []).length !== 1 || answer.length > 100))) {
        reasons.answer++; continue;
      }
    }
    valid.push({ type, question, answer, choices, page, source_excerpt: excerpt });
  }
  // Only aggregate diagnostics: never print student PDF text, questions, or keys.
  if (valid.length < list.length) {
    console.warn(`[TraceCard AI] Provider validation: ${valid.length}/${list.length} accepted; rejected=${JSON.stringify(reasons)}`);
  }
  if (!valid.length) throw new AIError('Provider returned flashcards that failed format validation.', 502);
  return valid;
}

function extractGeminiText(body) {
  if (typeof body?.output_text === 'string' && body.output_text.trim()) {
    return body.output_text;
  }
  const steps = body?.steps || body?.interaction?.steps || [];
  const texts = [];
  for (const step of steps) {
    if (step?.type !== 'model_output') continue;
    for (const item of step.content || []) {
      if (item?.type === 'text' && typeof item.text === 'string') {
        texts.push(item.text);
      }
    }
  }
  return texts.join('').trim();
}

async function postJSON(provider, url, body, headers, externalSignal = null) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), PROVIDER_TIMEOUT_MS);
  let response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify(body),
      signal: externalSignal ? AbortSignal.any([controller.signal, externalSignal]) : controller.signal,
    });

    if (externalSignal?.aborted) throw new AIError('Generation cancelled.', 499);
    const text = await response.text();
    let data;
    try { data = JSON.parse(text); } catch { data = {}; }

    if (!response.ok) {
      const err = new AIError(`${provider.id} HTTP ${response.status}`, response.status);
      const retryAfter = response.headers.get('retry-after');
      const retrySeconds = Number(retryAfter);
      if (Number.isFinite(retrySeconds) && retrySeconds > 0) {
        err.retryAfterMs = retrySeconds * 1000;
      } else if (retryAfter) {
        const dateMs = Date.parse(retryAfter) - Date.now();
        if (Number.isFinite(dateMs) && dateMs > 0) err.retryAfterMs = dateMs;
      }
      throw err;
    }
    return data;
  } catch (error) {
    if (error?.name === 'AbortError') {
      if (externalSignal?.aborted) throw new AIError('Generation cancelled.', 499);
      throw new AIError(`${provider.id} timed out.`, 504);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

async function askGemini(provider, prompt, schema, signal = null) {
  const data = await postJSON(provider,
    'https://generativelanguage.googleapis.com/v1beta/interactions',
    {
      model: provider.model,
      input: prompt,
      generation_config: { thinking_level: 'low' },

      response_format: { type: 'text', mime_type: 'application/json', schema },
    },
    { 'x-goog-api-key': provider.key }, signal,
  );
  return extractGeminiText(data);
}


async function askChatCompletion(provider, prompt, schema, signal = null) {
  const urls = {
    groq: 'https://api.groq.com/openai/v1/chat/completions',
    openrouter: 'https://openrouter.ai/api/v1/chat/completions',
    openai: 'https://api.openai.com/v1/chat/completions',
  };
  const url = urls[provider.id];
  if (!url) throw new AIError('Unsupported chat completion provider.', 500);
  const jsonInstructions =
    'You generate accurate flashcards from user-supplied PDF text only. ' +
    'Return ONLY a valid JSON object with one "flashcards" array. ' +
    'Preserve the requested question type. Each card needs type, question, answer, choices, page, source_excerpt. ' +
    'For MCQ use exactly 4 distinct answer choices. For identification and fillblank use a string answer and empty choices. ' +
    'For enumeration return an ARRAY of 2-5 strings and empty choices. ' +
    'For fillblank use exactly one ____ in the question. ' +
    'Copy source_excerpt exactly from the referenced page (10-160 characters). ' +
    'Never invent source text. Output must match this JSON Schema: ' + JSON.stringify(schema);
  const body = {
    model: provider.model,
    messages: [
      { role: 'system', content: jsonInstructions },
      { role: 'user', content: prompt },
    ],
    temperature: 0.2,
    max_tokens: 8192,
  };

  if (provider.id === 'groq') {

    const strictSupported = /^openai\/gpt-oss-(?:20b|120b)$/i.test(provider.model);
    if (strictSupported) body.reasoning_effort = 'low';
    body.response_format = strictSupported
      ? { type: 'json_schema', json_schema: { name: 'tracecard_flashcards', strict: true, schema } }
      : { type: 'json_object' };
  } else if (provider.id === 'openai') {

    body.response_format = {
      type: 'json_schema',
      json_schema: { name: 'tracecard_flashcards', strict: true, schema },
    };
  } else if (provider.id === 'openrouter' &&
             process.env.OPENROUTER_STRUCTURED_OUTPUTS === 'true' &&
             provider.model !== 'openrouter/free') {

    body.response_format = {
      type: 'json_schema',
      json_schema: { name: 'tracecard_flashcards', strict: true, schema },
    };
  }
  const data = await postJSON(provider, url, body, {
    Authorization: `Bearer ${provider.key}`,
    ...(provider.id === 'openrouter' ? { 'X-Title': 'TraceCard AI' } : {}),
  }, signal);
  const content = data?.choices?.[0]?.message?.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.filter(x => x?.type === 'text').map(x => x.text).join('');
  return '';
}

function recordFailure(provider, error) {
  const status = Number(error?.status);
  let cooldownMs = 0;
  if (status === 429) cooldownMs = Math.max(60000, error.retryAfterMs || 0);
  else if ([400, 401, 402, 403, 404].includes(status)) cooldownMs = 120000;
  else if ([500, 502, 503, 504].includes(status)) cooldownMs = 10000;
  if (cooldownMs) cooldownUntil.set(provider.id, Date.now() + Math.min(cooldownMs, 300000));

  console.warn(`[TraceCard AI] ${provider.id} failed: ${status || 'network/format error'}`);
}

async function generateFlashcards(prompt, requestedType = 'mcq', signal = null, sourcePages = null) {
  const schema = buildResponseSchema(requestedType);
  let tried = 0;
  for (const provider of PROVIDERS) {
    if (signal?.aborted) throw new AIError('Generation cancelled.', 499);
    if (!provider.key) continue;
    if ((cooldownUntil.get(provider.id) || 0) > Date.now()) continue;
    tried++;
    const startedAt=Date.now();
    try {
      const raw = provider.id === 'gemini'
        ? await askGemini(provider, prompt, schema, signal)
        : await askChatCompletion(provider, prompt, schema, signal);
      let cards;
      try { cards = parseFlashcards(raw, requestedType, prompt, sourcePages); }
      catch (error) { error.validationFailure = true; throw error; }
      console.info(`[TraceCard AI] ${provider.id}: ${cards.length} valid ${requestedType} cards in ${Date.now()-startedAt}ms`);
      return cards;
    } catch (error) {
      if (signal?.aborted || error?.status === 499) throw new AIError('Generation cancelled.', 499);
      if (error.validationFailure) console.warn(`[TraceCard AI] ${provider.id}: response failed card validation; trying fallback`);
      else recordFailure(provider, error);
    }
  }
  const configured = PROVIDERS.some(p => p.key);
  if (!configured) {
    throw new AIError('No AI provider configured. Add API keys to your server .env file.', 503);
  }
  const availableAt = Math.min(...PROVIDERS.filter(p => p.key).map(p => Math.max(Date.now(), cooldownUntil.get(p.id) || 0)));
  const error = new AIError(tried ? 'All AI providers failed or are unavailable. Please try again later.' : 'All AI providers are temporarily cooling down. Try again shortly.', 503);
  error.retryAfterMs = Math.max(0, availableAt - Date.now());
  error.cooldownOnly = !tried;
  throw error;
}

app.get('/api/health', (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json({
    ok: true,
    backendVersion: TC_BACKEND_VERSION,
    aiConfigured: PROVIDERS.some(p => Boolean(p.key)),
    providers: PROVIDERS.map(p => ({
      name: p.id,
      configured: Boolean(p.key),
      available: Boolean(p.key) && (cooldownUntil.get(p.id) || 0) <= Date.now(),
    })),
    concurrency: { active, queued: queue.length, maximum: MAX_ACTIVE },
    background: { configured: BG_CONFIGURED, mode: IS_VERCEL ? (typeof backgroundWaitUntil === 'function' ? 'vercel-waitUntil' : 'status-driven') : 'worker', globalConcurrency: BG_CONCURRENCY, batchSize: BG_BATCH_SIZE },
  });
});

async function handleGenerate(req, res) {
  const prompt = req.body?.prompt;
  if (typeof prompt !== 'string' || !prompt.trim()) {
    return res.status(400).json({ error: 'Missing AI prompt.' });
  }
  if (prompt.length > MAX_PROMPT_CHARS) {
    return res.status(413).json({ error: 'AI prompt is too long. Try fewer PDF pages.' });
  }
  try {
    const requestedType = requestedCardType(prompt, req.body?.responseSchema);
    const cards = await queueTask(() => generateFlashcards(prompt.trim(), requestedType));
    res.set('Cache-Control', 'no-store');
    res.json(cards);
  } catch (error) {
    const status = [400, 413, 429, 502, 503, 504].includes(error?.status) ? error.status : 500;
    res.status(status).json({
      error: error?.message || 'Flashcard generation failed.',
    });
  }
}

app.post('/api/gemini', handleGenerate);
app.post('/api/flashcards', handleGenerate);

// Durable background-generation jobs. Requires UPSTASH_REDIS_REST_URL +
// UPSTASH_REDIS_REST_TOKEN. No client PDF binary or provider keys are stored.
// The job ID is a secret bearer capability. Keep it out of URLs and logs.
const crypto = require('crypto');
const REDIS_URL = (process.env.UPSTASH_REDIS_REST_URL || '').trim().replace(/\/$/, '');
const REDIS_TOKEN = (process.env.UPSTASH_REDIS_REST_TOKEN || '').trim();
const BG_CONFIGURED = Boolean(REDIS_URL && REDIS_TOKEN && /^https:\/\//.test(REDIS_URL));
const BG_PREFIX = 'tracecard:bg:v1:';
const BG_DUE_KEY = BG_PREFIX + 'due';
const BG_TTL_SECONDS = 7 * 24 * 60 * 60;
// One batch can attempt several providers serially; lease must cover their combined timeouts.
const BG_BATCH_DEADLINE_MS = boundedInteger('BG_BATCH_DEADLINE_MS', 45000, 10000, 90000);
const BG_LEASE_SECONDS = Math.ceil(BG_BATCH_DEADLINE_MS / 1000) + 65;
const BG_CONCURRENCY = Math.min(MAX_ACTIVE, boundedInteger('BG_CONCURRENCY', 5, 1, 15));
const BG_BATCH_SIZE = boundedInteger('BG_BATCH_SIZE', 10, 5, 15);
const BG_SLOT_KEY = BG_PREFIX + 'worker-slots';
// Maximum time to start more batches within one Vercel invocation.
const BG_VERCEL_RUN_MS = boundedInteger('BG_VERCEL_RUN_MS', 45000, 5000, 120000);
const BG_MAX_SOURCE_CHARS = boundedInteger('BG_MAX_SOURCE_CHARS', 120000, 10000, 250000);
const BG_POLL_MS = boundedInteger('BG_POLL_MS', 3500, 2000, 15000);
const BG_MAX_ATTEMPTS_PER_SET = boundedInteger('BG_MAX_ATTEMPTS_PER_SET', 6, 1, 20);
const BG_MAX_STALLS = boundedInteger('BG_MAX_STALLS', 5, 1, 15);
let bgActive = 0;
let bgTimer = null;
let bgTickRunning = false;
const bgLocalProcessing = new Set();
const bgRunningControllers = new Map();

async function bgRedis(...cmd) {
  if (!BG_CONFIGURED) throw new AIError('Background storage is not configured.', 503);
  const c = new AbortController();
  const timeout = setTimeout(() => c.abort(), 12000);
  try {
    const res = await fetch(REDIS_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${REDIS_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(cmd),
      signal: c.signal,
    });
    const data = await res.json();
    if (!res.ok || data?.error) throw new Error('Storage command failed.');
    return data.result;
  } catch {
    throw new AIError('Background storage is temporarily unavailable.', 503);
  } finally { clearTimeout(timeout); }
}
function bgKey(id) { return BG_PREFIX + 'job:' + id; }
function bgLockKey(id) { return BG_PREFIX + 'lock:' + id; }
function bgCancelKey(id) { return BG_PREFIX + 'cancel:' + id; }
function bgSafeJobID(id) { return typeof id === 'string' && /^[A-Za-z0-9_-]{32}$/.test(id); }
async function bgGet(id) {
  const raw = await bgRedis('GET', bgKey(id));
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { throw new AIError('Stored job could not be read.', 503); }
}
const BG_SAVE_SCRIPT = `
if redis.call('GET', KEYS[2]) ~= ARGV[1] then return 0 end
-- A user cancellation always wins against a currently executing AI batch.
if redis.call('GET', KEYS[4]) then
  redis.call('ZREM', KEYS[3], ARGV[5])
  return 2
end
redis.call('SET', KEYS[1], ARGV[2], 'EX', ARGV[3])
if ARGV[4] == 'done' then
  redis.call('ZREM', KEYS[3], ARGV[5])
else
  redis.call('ZADD', KEYS[3], ARGV[6], ARGV[5])
end
return 1`;
// Atomically claim a due job AND a global slot (across Vercel instances).
// Redis server time avoids different invocation clocks affecting lease expiry.
const BG_CLAIM_SCRIPT = `
local t = redis.call('TIME')
local now = tonumber(t[1])*1000 + math.floor(tonumber(t[2])/1000)
redis.call('ZREMRANGEBYSCORE', KEYS[3], '-inf', now)
local due = redis.call('ZSCORE', KEYS[2], ARGV[3])
if not due or tonumber(due) > now then return 0 end
if redis.call('EXISTS', KEYS[1]) == 1 then return 0 end
if redis.call('ZCARD', KEYS[3]) >= tonumber(ARGV[4]) then return 0 end
local untilMs = now + tonumber(ARGV[2])*1000
redis.call('SET', KEYS[1], ARGV[1], 'EX', ARGV[2])
redis.call('ZADD', KEYS[3], untilMs, ARGV[1])
redis.call('ZADD', KEYS[2], untilMs, ARGV[3])
return 1`;
const BG_UNLOCK_SCRIPT = `
redis.call('ZREM', KEYS[2], ARGV[1])
if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) end
return 0`;
async function bgSaveClaimed(job, token, nextRunAt) {
  job.updatedAt = Date.now();
  const done = ['completed', 'failed', 'cancelled'].includes(job.status);
  const result = await bgRedis('EVAL', BG_SAVE_SCRIPT, 4,
    bgKey(job.id), bgLockKey(job.id), BG_DUE_KEY, bgCancelKey(job.id),
    token, JSON.stringify(job), BG_TTL_SECONDS, done ? 'done' : 'due', job.id, nextRunAt);
  if (Number(result) === 2) return;
  if (Number(result) !== 1) throw new AIError('Background job lease expired; will recover from checkpoint.', 503);
}
async function bgUnlock(id, token) {
  try { await bgRedis('EVAL', BG_UNLOCK_SCRIPT, 2, bgLockKey(id), BG_SLOT_KEY, token); }
  catch { /* The expiring lock safely releases itself. */ }
}
function bgPublic(job) {
  return {
    jobId: job.id,
    status: job.status,
    savedCards: job.sets.reduce((n, s) => n + (Array.isArray(s.cards) ? s.cards.length : 0), 0),
    totalCards: job.setCount * job.cardsPerSet,
    sets: job.sets.map(s => ({
      setNumber: s.setNumber,
      completed: s.status === 'completed',
      status: s.status,
      cards: s.status === 'completed' ? s.cards : [],
    })),
    message: job.message || '',
  };
}
function bgTypeCounts(count, kind) {
  if (kind !== 'mixed') return { [kind]: count };
  const kinds = ['mcq', 'identification', 'enumeration', 'fillblank'];
  const base = Math.floor(count / 4);
  return Object.fromEntries(kinds.map((t, i) => [t, base + (i < count % 4 ? 1 : 0)]));
}
function bgNextType(set, counts) {
  return Object.keys(counts).find(t => set.cards.filter(c => c.type === t).length < counts[t]);
}
function bgBadQuestion(q) {
  const question = String(q || '');

  return /\b(?:page|slide)\s*(?:no\.?\s*|number\s*|#\s*)?\d+\b/i.test(question) ||
    /\b(?:this|the|uploaded|provided)\s+(?:pdf|document|file|slides?|lecture|module|handout)\b/i.test(question) ||
    /\b(?:in|on|from|of|according to|as (?:shown|stated|described) in|based on)\s+(?:(?:the|this|provided|uploaded)\s+)?(?:pages?|slides?|pdf|document|file|source text)\b/i.test(question) ||
    /\b(?:who (?:wrote|authored|prepared|published)|(?:name|identify) the (?:author|owner|instructor|professor|publisher)|copyright|all rights reserved|prepared by|submitted by|written by)\b/i.test(question);
}
function bgPrompt(job, set, wanted, count) {
  const skip = set.attempts || 0;
  const chosen = Array.from({ length: Math.min(5, job.pages.length) }, (_, i) =>
    job.pages[(set.setNumber * 3 + skip * 5 + i) % job.pages.length]);
  const source = chosen.map(p => `PAGE ${p.page}: ${p.text.slice(0, 2600)}`).join('\n\n');
  const avoided = job.sets.flatMap(s => s.cards.map(c => c.question)).slice(-45);
  const typeRule = wanted === 'mcq' ? 'Exactly four distinct choices, including the correct answer.' :
    wanted === 'enumeration' ? 'Answer must be an array of 2-5 distinct short items supported by the source page. Use no choices.' :
    wanted === 'fillblank' ? 'Use exactly one ____ blank and a short string answer. Use no choices.' :
    'Use a short factual string answer and no choices.';
  return `Write EXACTLY ${count} unique, natural college-level ${wanted} flashcards based ONLY on the supplied text.\n` +
    `Type: ${wanted}. ${typeRule}\n` +
    `Each card must have type, question, answer, choices, page (original PDF page number), and source_excerpt (an exact 10-160 character quote from that page).\n` +
    `No duplicates. Do not mention page, slide, chapter, document, lecturer, ownership, or metadata in the question.\n` +
    `Output ONLY JSON with a flashcards array. Never invent facts or source excerpts.\n` +
    `Avoid these already-generated questions: ${JSON.stringify(avoided)}\n` +
    source;
}
function bgVerifyCard(card, job, used) {
  if (bgBadQuestion(card.question) || used.has(card.question.trim().toLowerCase())) return false;
  if (!Number.isInteger(card.page) || card.page < 1) return false;
  const sourcePage = job.pages.find(p => p.page === card.page);

  return Boolean(sourcePage && sourceExcerptOnPage(sourcePage.text, card.source_excerpt));
}
async function bgProcessBatch(job, signal = null) {
  const set = job.sets.find(s => s.status !== 'completed');
  if (!set) { job.status = 'completed'; job.message = 'All flashcards generated.'; return 0; }
  const quota = bgTypeCounts(job.cardsPerSet, job.questionType);
  const type = bgNextType(set, quota);
  if (!type) {
    set.status = 'completed';
    set.completedAt = set.completedAt || Date.now();
    if (job.sets.every(s => s.status === 'completed')) job.status = 'completed';
    return 0;
  }

  const want = Math.min(BG_BATCH_SIZE, quota[type] - set.cards.filter(c => c.type === type).length);
  const prompt = bgPrompt(job, set, type, want);
  set.attempts++;
  // The Redis slot is the concurrency limit for background requests. Do not
  // also wait in the legacy in-memory queue while holding a timed lease.
  let batch;
  try { batch = await generateFlashcards(prompt, type, signal, job.pages); }
  catch (error) {
    if (error.cooldownOnly) set.attempts--; // No AI request was actually made.
    throw error;
  }
  const used = new Set(job.sets.flatMap(s => s.cards.map(c => c.question.trim().toLowerCase())));
  let added = 0;
  for (const card of batch) {
    if (set.cards.length >= job.cardsPerSet) break;
    if (set.cards.filter(c => c.type === type).length >= quota[type]) break;
    if (!bgVerifyCard(card, job, used)) continue;
    set.cards.push(card);
    used.add(card.question.trim().toLowerCase());
    added++;
  }
  if (set.cards.length === job.cardsPerSet) { set.status = 'completed'; set.completedAt = set.completedAt || Date.now(); }
  if (job.sets.every(s => s.status === 'completed')) {
    job.status = 'completed';
    job.message = 'All flashcards generated.';
  } else job.status = 'running';
  console.info(`[TraceCard AI] Batch validation: requested=${want}, returned=${batch.length}, accepted=${added}`);
  return added;
}
function bgRetryLimitReached(job) {
  const currentSet = job.sets.find(s => s.status !== 'completed');
  return (job.stalls || 0) >= BG_MAX_STALLS ||
    Boolean(currentSet && (currentSet.attempts || 0) >= job.cardsPerSet + BG_MAX_ATTEMPTS_PER_SET);
}
async function bgRunOneJob(id) {
  const token = crypto.randomBytes(20).toString('hex');
  const locked = await bgRedis('EVAL', BG_CLAIM_SCRIPT, 3, bgLockKey(id), BG_DUE_KEY, BG_SLOT_KEY,
    token, BG_LEASE_SECONDS, id, BG_CONCURRENCY);
  if (Number(locked) !== 1) return false;
  try {
    const job = await bgGet(id);
    if (!job || ['completed', 'failed', 'cancelled'].includes(job.status)) {
      await bgRedis('ZREM', BG_DUE_KEY, id);return;
    }

    job.status = 'running';
    const aborter = new AbortController();
    bgRunningControllers.set(id, aborter);
    let nextRunAt = Date.now();
    const timer = setTimeout(() => aborter.abort(), BG_BATCH_DEADLINE_MS);
    const before = job.sets.reduce((n,s)=>n+s.cards.length,0);
    const batchStarted = Date.now();
    try {
      const added = await bgProcessBatch(job, aborter.signal);
      job.failures = 0;
      if (job.status === 'running') {
        job.stalls = added > 0 ? 0 : (job.stalls || 0) + 1;
        if (bgRetryLimitReached(job)) {
          job.status = 'failed';
          job.message = 'Generation stopped after reaching the retry limit. Completed sets are saved; incomplete sets are not shown.';
        }
      }

    } catch (e) {
      if (!e?.cooldownOnly) job.failures = (job.failures || 0) + 1;
      const delay = Math.min(300000, Math.max(e?.retryAfterMs || 0, 3000 * 2 ** Math.min(Math.max(0,(job.failures || 0)-1), 5)));
      nextRunAt = Date.now() + delay;
      if (!e?.cooldownOnly && (job.failures >= BG_MAX_ATTEMPTS_PER_SET || bgRetryLimitReached(job))) {
        job.status = 'failed';
        job.message = 'Generation stopped after repeated AI failures. Completed sets are saved; incomplete sets are not shown.';
      }
      console.warn(`[TraceCard AI] Background batch failed (${e?.status || 'provider'}); retry ${job.failures}`);
    } finally { clearTimeout(timer); }
    await bgSaveClaimed(job, token, nextRunAt);
    const after = job.sets.reduce((n,s)=>n+s.cards.length,0);
    console.info(`[TraceCard AI] Batch checkpoint: +${after-before}, ${after}/${job.setCount*job.cardsPerSet} saved, ${Date.now()-batchStarted}ms, ${job.status}`);
    return job.status === 'running' && job.failures === 0 && after > before;
  } finally { bgRunningControllers.delete(id); await bgUnlock(id, token); }
}
// Vercel does not run a permanent setInterval worker. Resume the specific
// saved job from both the creation request and status polling. waitUntil tracks
// the promise, including the actual AI request and Redis checkpoint.
const bgVercelRuns = new Map();
async function bgRunVercelWindow(id) {
  const stopStartingAt = Date.now() + BG_VERCEL_RUN_MS;
  do {
    const more = await bgRunOneJob(id);
    if (!more) break;
    // A checkpoint has been committed and the lock released before the next batch.
  } while (Date.now() < stopStartingAt);
}
function bgKickVercel(id) {
  if (bgVercelRuns.has(id)) return true;
  if (typeof backgroundWaitUntil !== 'function') return false;
  // Register a deferred task before starting work. A missing/invalid request
  // context must not leave a saved job unconfirmed or start an untracked batch.
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const task = gate.then(start => start ? bgRunVercelWindow(id) : undefined)
    .catch(e => console.warn(`[TraceCard AI] Vercel job worker: ${e?.message || 'error'}`))
    .finally(() => { if (bgVercelRuns.get(id) === task) bgVercelRuns.delete(id); });
  try {
    backgroundWaitUntil(task);
    bgVercelRuns.set(id, task);
    release(true);
    return true;
  } catch {
    release(false);
    console.warn('[TraceCard AI] Vercel scheduling unavailable; status requests will process the job.');
    return false;
  }
}

async function bgTick() {
  if (!BG_CONFIGURED || bgTickRunning || bgActive >= BG_CONCURRENCY) return;
  bgTickRunning = true;
  try {
    const ready = await bgRedis('ZRANGEBYSCORE', BG_DUE_KEY, '-inf', Date.now(), 'LIMIT', 0, BG_CONCURRENCY * 5);
    for (const id of ready || []) {
      if (bgActive >= BG_CONCURRENCY) break;
      if (!bgSafeJobID(id) || bgLocalProcessing.has(id)) continue;
      bgLocalProcessing.add(id);
      bgActive++;
      void bgRunOneJob(id).catch(e => console.warn(`[TraceCard AI] Background worker: ${e?.message || 'error'}`))
        .finally(() => {
          bgActive--;bgLocalProcessing.delete(id);

          const next=setTimeout(() => { void bgTick(); }, 450);
          next.unref?.();
        });
    }
  } catch (error) {
    console.warn(`[TraceCard AI] Background queue unavailable: ${error.message}`);
  } finally { bgTickRunning = false; }
}
function bgStartWorker() {
  if (!BG_CONFIGURED || bgTimer) return;
  bgTimer = setInterval(() => { void bgTick(); }, BG_POLL_MS);
  if (!process.argv.includes('--worker')) bgTimer.unref?.();
  void bgTick();
  console.info('[TraceCard AI] Durable background generation worker started.');
}

const bgRate = new Map();
function bgBasicRateLimit(req) {
  const now = Date.now();
  const key = req.ip;
  const window = bgRate.get(key) || { count: 0, until: now + 60000 };
  if (now >= window.until) { window.count = 0; window.until = now + 60000; }
  window.count++;
  bgRate.set(key, window);

  return window.count <= 60;
}
function bgValidateRequest(body) {
  if (!body || typeof body !== 'object') throw new AIError('Invalid generation request.', 400);
  const pdfName = typeof body.pdfName === 'string' ? body.pdfName.slice(0, 120) : 'Document.pdf';
  const fileSignature = String(body.fileSignature || '').slice(0, 80);
  const questionType = body.questionType;
  const setCount = Number(body.sets);
  const cardsPerSet = Number(body.cardsPerSet);
  if (!['mixed', ...CARD_TYPES].includes(questionType) || !Number.isInteger(setCount) || setCount < 1 || setCount > 5 ||
      ![10, 20, 30].includes(cardsPerSet)) throw new AIError('Invalid question type, sets, or cards per set.', 400);
  if (!Array.isArray(body.pages) || !body.pages.length || body.pages.length > 100) throw new AIError('Invalid PDF page data.', 400);
  let chars = 0;
  const seen = new Set();
  const pages = body.pages.map((p, i) => {
    const page = Number(p?.page), text = p?.text;
    if (!Number.isInteger(page) || page < 1 || page > 5000 || seen.has(page) || typeof text !== 'string' || text.length > 30000)
      throw new AIError('Invalid PDF page data.', 400);
    seen.add(page);
    chars += text.length;
    return { page, text };
  });
  if (chars < 50 || chars > BG_MAX_SOURCE_CHARS) throw new AIError('PDF text is too short or exceeds background limits.', 413);
  const readable = pages.filter(p => p.text.trim().length > 50);
  if (!readable.length) throw new AIError('No readable PDF text found.', 400);
  return { pdfName, fileSignature, questionType, setCount, cardsPerSet, pages: readable };
}
app.get('/api/generation-jobs/capabilities', async (_req, res) => {
  res.set('Cache-Control', 'no-store');
  if (!BG_CONFIGURED || !PROVIDERS.some(p => p.key)) return res.json({ enabled: false, persistent: false, version: 1 });
  try {
    await bgRedis('PING');
    res.json({ enabled: true, persistent: true, version: 1, cancelProtocol: 2 });
  } catch { res.json({ enabled: false, persistent: false, version: 1 }); }
});
app.post('/api/generation-jobs', async (req, res) => {
  res.set('Cache-Control', 'no-store');
  if (!BG_CONFIGURED) return res.status(503).json({ error: 'Durable background storage is not configured.' });
  if (!bgBasicRateLimit(req)) return res.status(429).json({ error: 'Too many generation requests. Try again later.' });
  try {
    const input = bgValidateRequest(req.body);
    const id = crypto.randomBytes(24).toString('base64url');
    const job = {
      id, ...input, status: 'queued', message: '', createdAt: Date.now(), updatedAt: Date.now(),
      failures: 0, stalls: 0,
      sets: Array.from({ length: input.setCount }, (_, i) => ({setNumber:i+1, status:'queued', attempts:0, cards:[]})),
    };

    const script = `redis.call('SET', KEYS[1], ARGV[1], 'EX', ARGV[2]); redis.call('ZADD', KEYS[2], ARGV[3], ARGV[4]); return 1`;
    await bgRedis('EVAL', script, 2, bgKey(id), BG_DUE_KEY,
      JSON.stringify(job), BG_TTL_SECONDS, Date.now(), id);

    if (IS_VERCEL) bgKickVercel(id);
    res.status(202).json(bgPublic(job));
    if (!IS_VERCEL) void bgTick();
  } catch (e) {
    res.status([400, 413, 429, 503].includes(e?.status) ? e.status : 500)
      .json({ error: e?.message || 'Could not start background generation.' });
  }
});

const BG_CANCEL_SCRIPT = `
local raw = redis.call('GET', KEYS[1])
if not raw then return 0 end
local job = cjson.decode(raw)
if job.status == 'completed' then return 2 end
if job.status == 'cancelled' then return 3 end
redis.call('SET', KEYS[3], '1', 'EX', ARGV[1])
-- Persist only FINISHED, complete sets. Discard partial cards for every unfinished set.
for _, set in ipairs(job.sets) do
  if set.status ~= 'completed' then
    set.cards = {}
    set.status = 'cancelled'
  end
end
job.status = 'cancelled'
job.message = 'Generation cancelled. Incomplete batches discarded; completed sets kept.'
job.pages = {}
job.updatedAt = tonumber(ARGV[3])
redis.call('SET', KEYS[1], cjson.encode(job), 'EX', ARGV[1])
redis.call('ZREM', KEYS[2], ARGV[2])
return 1`;
app.post('/api/generation-jobs/:jobId/cancel', async (req, res) => {
  res.set('Cache-Control', 'no-store');
  const id = req.params.jobId;
  if (!bgSafeJobID(id)) return res.status(404).json({error:'Job not found.'});
  try {
    const result = await bgRedis('EVAL', BG_CANCEL_SCRIPT, 3,
      bgKey(id), BG_DUE_KEY, bgCancelKey(id), BG_TTL_SECONDS, id, Date.now());
    if (Number(result) === 0) return res.status(404).json({error:'Job not found on this server/Redis instance. Verify Vercel server deployment and UPSTASH_REDIS_REST_URL.'});

    if (Number(result) === 1 || Number(result) === 3) bgRunningControllers.get(id)?.abort();
    const job = await bgGet(id);
    if (!job) return res.status(404).json({error:'Job not found or expired.'});
    res.json(bgPublic(job));
  } catch (e) {res.status(503).json({error:e?.message || 'Could not cancel job.'});}
});

app.get('/api/generation-jobs/:jobId', async (req, res) => {
  res.set('Cache-Control', 'no-store');
  if (!bgSafeJobID(req.params.jobId)) return res.status(404).json({error:'Job not found.'});
  try {
    const id = req.params.jobId;
    let job = await bgGet(id);
    if (!job) return res.status(404).json({error:'Job not found or expired.'});
    if (IS_VERCEL && !['completed','failed','cancelled'].includes(job.status)) {
      if (!bgKickVercel(id)) {
        // No new package needed for this fallback: finish one batch while the
        // HTTP request is alive. Redis locks prevent duplicate processing.
        await bgRunOneJob(id);
        job = await bgGet(id) || job;
      }
    }
    return res.json(bgPublic(job));
  } catch (e) { return res.status(503).json({error:e?.message || 'Job status unavailable.'}); }
});

// Research participation verification (no account or additional AI calls).
// Job IDs remain bearer capabilities; never expose them in the completion code.
const TC_PROOF_PREFIX = 'tracecard:research:v1:';
const TC_PROOF_TTL = 90 * 24 * 60 * 60;
const TC_PROOF_MIN = 10;
const tcProofSessionKey = id => TC_PROOF_PREFIX + 'session:' + id;
const tcProofJobKey = id => TC_PROOF_PREFIX + 'job:' + id;
const tcProofCodeKey = code => TC_PROOF_PREFIX + 'code:' + code;
const tcProofID = id => typeof id === 'string' && /^[a-f0-9]{32}$/.test(id);
const TC_PROOF_EVENT_SCRIPT = `
local raw = redis.call('GET', KEYS[1])
if not raw then return {'missing'} end
local session = cjson.decode(raw)
local idx = tonumber(ARGV[1])
local pos = nil
for i, v in ipairs(session.indices) do if v == idx then pos = i; break end end
if not pos then return {'invalid'} end
local eventKey = tostring(idx)
if not session.events[eventKey] then
  if pos ~= session.reviewed + 1 then return {'order'} end
  session.events[eventKey] = {at=tonumber(ARGV[2]), rating=ARGV[3]}
  session.reviewed = session.reviewed + 1
end
if session.reviewed < #session.indices then
  redis.call('SET', KEYS[1], cjson.encode(session), 'EX', ARGV[4])
  return {'progress', tostring(session.reviewed)}
end
local code = redis.call('GET', KEYS[2])
if not code then
  if redis.call('EXISTS', KEYS[3]) == 1 then return {'collision'} end
  code = ARGV[5]
  local record = {code=code, jobHash=ARGV[6], setNumber=session.setNumber,
    generatedCards=session.generatedCards, reviewedCards=session.reviewed,
    generationRequestedAt=session.generationRequestedAt, generationCompletedAt=session.generationCompletedAt,
    approvalReportedAt=session.startedAt, approvedCardsReported=#session.indices,
    reviewStartedAt=session.startedAt, completedAt=tonumber(ARGV[2]), status='verified', emailStatus='unbound'}
  redis.call('SET', KEYS[3], cjson.encode(record), 'EX', ARGV[4])
  redis.call('SET', KEYS[2], code, 'EX', ARGV[4])
end
session.code = code
redis.call('SET', KEYS[1], cjson.encode(session), 'EX', ARGV[4])
return {'complete', code, tostring(session.reviewed)}`;

app.post('/api/research/review/start', async (req, res) => {
  res.set('Cache-Control', 'no-store');
  const { jobId, setNumber, sessionId, indices } = req.body || {};
  if (!BG_CONFIGURED) return res.status(503).json({error:'Verification storage unavailable.'});
  if (!bgSafeJobID(jobId) || !tcProofID(sessionId) || !Number.isInteger(setNumber) ||
      !Array.isArray(indices) || indices.length < TC_PROOF_MIN || indices.length > 30 ||
      indices.some(i => !Number.isInteger(i) || i < 0) || new Set(indices).size !== indices.length)
    return res.status(400).json({error:'Review at least 10 approved cards from one generated set.'});
  try {
    const key = tcProofSessionKey(sessionId);
    const existing = await bgRedis('GET', key);
    if (existing) {
      const old = JSON.parse(existing);
      if (old.jobId !== jobId || old.setNumber !== setNumber || JSON.stringify(old.indices) !== JSON.stringify(indices))
        return res.status(409).json({error:'Review session does not match.'});
      return res.json({ok:true});
    }
    const job = await bgGet(jobId);
    const set = job?.sets?.find(s => s.setNumber === setNumber && s.status === 'completed');
    if (!set || !Array.isArray(set.cards) || set.cards.length !== job.cardsPerSet ||
        indices.some(i => i >= set.cards.length))
      return res.status(404).json({error:'Completed generated set not found. Generate a new set to verify participation.'});
    const proof = {jobId, setNumber, indices, generatedCards:set.cards.length,
      generationRequestedAt:job.createdAt, generationCompletedAt:set.completedAt || null, startedAt:Date.now(), reviewed:0, events:{}};
    const stored = await bgRedis('SET', key, JSON.stringify(proof), 'EX', TC_PROOF_TTL, 'NX');
    if (stored !== 'OK') {
      const raw = await bgRedis('GET',key);
      const old = raw ? JSON.parse(raw) : null;
      if (!old || old.jobId !== jobId || old.setNumber !== setNumber || JSON.stringify(old.indices) !== JSON.stringify(indices))
        return res.status(409).json({error:'Review session does not match.'});
    }
    return res.json({ok:true});
  } catch (e) { return res.status(503).json({error:'Verification temporarily unavailable. Try again.'}); }
});

app.post('/api/research/review/event', async (req, res) => {
  res.set('Cache-Control', 'no-store');
  const { sessionId, jobId, index, answer, rating } = req.body || {};
  if (!BG_CONFIGURED) return res.status(503).json({error:'Verification storage unavailable.'});
  if (!tcProofID(sessionId) || !bgSafeJobID(jobId) || !Number.isInteger(index) || index < 0 || index > 29 ||
      typeof answer !== 'string' || !answer.trim() || answer.length > 20000 ||
      !['Difficult','Partially Remembered','Remembered'].includes(rating))
    return res.status(400).json({error:'Invalid review activity.'});
  try {
    const key = tcProofSessionKey(sessionId);
    const raw = await bgRedis('GET', key);
    const proof = raw ? JSON.parse(raw) : null;
    if (!proof || proof.jobId !== jobId) return res.status(404).json({error:'Review verification session not found.'});
    // Only server timestamps, card indices and recall ratings are stored; answer text is not retained here.
    const hash = crypto.createHash('sha256').update(jobId).digest('hex');
    for (let attempt = 0; attempt < 3; attempt++) {
      const code = 'TC-' + crypto.randomBytes(10).toString('hex').toUpperCase().match(/.{5}/g).join('-');
      const result = await bgRedis('EVAL', TC_PROOF_EVENT_SCRIPT, 3, key, tcProofJobKey(hash), tcProofCodeKey(code),
        index, Date.now(), rating, TC_PROOF_TTL, code, hash);
      if (result?.[0] === 'collision') continue;
      if (result?.[0] === 'progress') return res.json({ok:true,reviewed:Number(result[1])});
      if (result?.[0] === 'complete') return res.json({ok:true,code:result[1],reviewed:Number(result[2])});
      return res.status(409).json({error:'Review activity is missing or out of order.'});
    }
    return res.status(503).json({error:'Could not allocate a completion code. Retry verification.'});
  } catch (e) { return res.status(503).json({error:'Verification temporarily unavailable. Try again.'}); }
});

// Bind the completed job's token to a self-reported survey email, once.
// The email is not authenticated; researchers compare it with the survey response.
const TC_PROOF_BIND_SCRIPT = `
local raw = redis.call('GET', KEYS[1])
if not raw then return {'missing'} end
local session = cjson.decode(raw)
if session.jobId ~= ARGV[1] or not session.code or session.reviewed < #session.indices then return {'incomplete'} end
if session.code ~= ARGV[2] then return {'incomplete'} end
local rawRecord = redis.call('GET', KEYS[2])
if not rawRecord then return {'missing'} end
local record = cjson.decode(rawRecord)
if record.status ~= 'verified' or record.jobHash ~= ARGV[3] then return {'incomplete'} end
if record.studentEmail and record.studentEmail ~= ARGV[4] then return {'bound'} end
if not record.studentEmail then
  record.studentEmail = ARGV[4]
  record.emailStatus = 'self-reported'
  record.emailBoundAt = tonumber(ARGV[5])
  redis.call('SET', KEYS[2], cjson.encode(record), 'KEEPTTL')
end
return {'ok', session.code}`;
// A claim is not shown to the student until the spreadsheet acknowledges it.
// Both settings are server-only. The Apps Script endpoint accepts only the secret.
const TC_SHEETS_URL = (process.env.TC_SHEETS_WEBHOOK_URL || '').trim();
const TC_SHEETS_SECRET = (process.env.TC_SHEETS_WEBHOOK_SECRET || '').trim();
function tcSheetsConfigured() {
  return /^https:\/\/script\.google\.com\/(?:a\/macros\/[^/]+\/|macros\/)s\/[A-Za-z0-9_-]+\/exec$/.test(TC_SHEETS_URL) && TC_SHEETS_SECRET.length >= 32;
}
async function tcRecordClaimInSheets(code, email) {
  if (!tcSheetsConfigured()) throw new Error('Survey storage is not configured.');
  // A stable pseudonymous record ID, not the private review session/job ID.
  const recordId = crypto.createHash('sha256').update('tracecard:sheet:' + code).digest('hex').slice(0,32);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 25000);
  try {
    const response = await fetch(TC_SHEETS_URL, {
      method:'POST', headers:{'Content-Type':'application/json'},
      body:JSON.stringify({secret:TC_SHEETS_SECRET,email,code,recordId}),
      redirect:'follow', signal:controller.signal,
    });
    if (!response.ok) throw new Error('Survey storage request failed.');
    const result = await response.json();
    if (result?.ok !== true) throw new Error('Survey storage did not acknowledge claim.');
  } finally { clearTimeout(timeout); }
}
app.post('/api/research/review/claim', async (req,res) => {
  res.set('Cache-Control','no-store');
  const {sessionId,jobId,email} = req.body || {};
  const normalized = typeof email === 'string' ? email.trim().toLowerCase() : '';
  if (!BG_CONFIGURED) return res.status(503).json({error:'Verification storage unavailable.'});
  if (!tcProofID(sessionId) || !bgSafeJobID(jobId) || normalized.length > 254 || !/^[a-z0-9._%+\-]+@cvsu\.edu\.ph$/.test(normalized))
    return res.status(400).json({error:'Enter your official CvSU email address (@cvsu.edu.ph).'});
  if (!tcSheetsConfigured()) return res.status(503).json({error:'Survey verification is not configured. Contact the researchers.'});
  try {
    const key=tcProofSessionKey(sessionId), raw=await bgRedis('GET',key);
    const proof=raw?JSON.parse(raw):null;
    if (!proof || proof.jobId!==jobId || !/^TC-(?:[A-F0-9]{5}-){3}[A-F0-9]{5}$/.test(proof.code||''))
      return res.status(409).json({error:'Complete your review before claiming a code.'});
    const hash=crypto.createHash('sha256').update(jobId).digest('hex');
    const result=await bgRedis('EVAL',TC_PROOF_BIND_SCRIPT,2,key,tcProofCodeKey(proof.code),jobId,proof.code,hash,normalized,Date.now());
    if(result?.[0]==='ok'){
      try { await tcRecordClaimInSheets(result[1],normalized); }
      catch { return res.status(503).json({error:'Could not save your completion code to the research records. Retry using the same email.'}); }
      return res.json({ok:true,code:result[1]});
    }
    if(result?.[0]==='bound')return res.status(409).json({error:'This code is already linked to another email. Contact the researchers if you entered the wrong address.'});
    return res.status(409).json({error:'Verification is incomplete or expired. Generate and review a new set.'});
  }catch{return res.status(503).json({error:'Verification temporarily unavailable. Please retry.'});}
});

app.get(['/', '/index.html'], (req, res) => {

  const fs = require('fs');
  const publicHome = path.join(__dirname, 'public', 'index.html');
  const rootHome = path.join(__dirname, 'index.html');
  const home = fs.existsSync(publicHome) ? publicHome : rootHome;
  if (fs.existsSync(home)) return res.sendFile(home);
  return res.status(404).json({error:'Frontend not found. Put index.html in public/.'});
});
app.use('/assets', express.static(path.join(__dirname, 'assets'), { dotfiles: 'deny' }));
app.use((req, res) => res.status(404).json({ error: 'Not found.' }));

if (require.main === module && !process.env.VERCEL) {
  if (process.argv.includes('--worker')) {
    if (!BG_CONFIGURED) {
      console.error('Worker requires UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN.');
      process.exitCode = 1;
    } else {
      bgStartWorker();
    }
  } else {
    app.listen(PORT, () => {
      console.log(`TraceCard AI running at http://localhost:${PORT}`);
      console.log('Configured AI providers:', PROVIDERS.filter(p => p.key).map(p => p.id).join(' -> ') || 'none');
      bgStartWorker(); 
    });
  }
}

module.exports = app;
Object.assign(module.exports, {
  app, parseFlashcards, extractGeminiText,
  generateFlashcards, buildResponseSchema, requestedCardType,
});
if (process.env.NODE_ENV === 'test') module.exports.__test = {bgTick, bgGet, bgValidateRequest, bgRunOneJob, bgBadQuestion, bgVerifyCard, sourceExcerptOnPage, bgRetryLimitReached, bgRunVercelWindow};
