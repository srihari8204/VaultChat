// routes/ai.js — real on-prem AI via Ollama (running on the box at OLLAMA_URL).
//
// Replaces the canned/pattern-matched responses in the AI screens with actual
// LLM output. Auth-required + rate-limited (LLM calls are expensive). If Ollama
// is unreachable or the model isn't pulled, returns 503 so the client can show
// an honest "AI unavailable" state rather than faking a reply.
//
// Env: OLLAMA_URL (default http://localhost:11434), OLLAMA_MODEL (default llama3.2).

const express   = require('express');
const jwtUtil   = require('../jwt');
const rateLimit = require('../rateLimit');

const router = express.Router();

const OLLAMA_URL   = (process.env.OLLAMA_URL || 'http://localhost:11434').replace(/\/$/, '');
const OLLAMA_MODEL = process.env.OLLAMA_MODEL || 'llama3.2';
const TIMEOUT_MS   = 30000;

router.use(jwtUtil.requireAuth);

// 30 AI calls / minute / user — protects the single Ollama instance.
router.use(async (req, res, next) => {
  try {
    const rl = await rateLimit.consume(`ai:${req.user.id}`, 30, 60);
    if (!rl.allowed) {
      return res.status(429).json({ error: 'Too many AI requests — slow down', retryAfter: rl.resetInSec });
    }
  } catch { /* limiter down → fail open */ }
  next();
});

async function ollama(path, body) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const r = await fetch(`${OLLAMA_URL}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: OLLAMA_MODEL, stream: false, ...body }),
      signal: ctrl.signal,
    });
    if (!r.ok) throw new Error(`Ollama ${r.status}`);
    return await r.json();
  } finally {
    clearTimeout(timer);
  }
}

// POST /ai/chat  { message, history?: [{ role:'user'|'assistant', content }] }
router.post('/chat', async (req, res) => {
  try {
    const message = (req.body?.message || '').toString().slice(0, 2000).trim();
    if (!message) return res.status(400).json({ error: 'message required' });
    const history = Array.isArray(req.body?.history) ? req.body.history.slice(-10) : [];

    const j = await ollama('/api/chat', {
      messages: [
        { role: 'system', content: "You are Aria, VaultChat's helpful, privacy-respecting assistant. Be concise, friendly, and never claim to access the user's private messages." },
        ...history.map((h) => ({
          role: h.role === 'user' ? 'user' : 'assistant',
          content: String(h.content || '').slice(0, 2000),
        })),
        { role: 'user', content: message },
      ],
    });
    res.json({ reply: (j.message?.content || '').trim() });
  } catch (err) {
    console.error('[ai chat]', err.message);
    res.status(503).json({ error: 'AI is unavailable right now' });
  }
});

// POST /ai/assist  { task, text } — in-chat helper tasks over user-provided text.
const TASKS = {
  summarize: 'Summarize the following conversation in 2-3 short bullet points. Be neutral and concise:',
  suggest:   'Suggest three short, natural reply options to the following message. Return only a numbered list:',
  translate: 'Detect the language of the following text and translate it to English (if it is already English, translate to Spanish). Return only the translation:',
  tone:      'Describe the tone of the following message in one short sentence:',
  grammar:   'Rewrite the following text with correct grammar and spelling, keeping its meaning and tone. Return only the corrected text:',
  shorten:   'Rewrite the following text to be shorter and clearer. Return only the rewritten text:',
};

router.post('/assist', async (req, res) => {
  try {
    const task = (req.body?.task || '').toString();
    const text = (req.body?.text || '').toString().slice(0, 4000).trim();
    let instruction = TASKS[task];
    if (!instruction) return res.status(400).json({ error: 'unknown task' });
    if (!text) return res.status(400).json({ error: 'text required' });

    // Translate accepts an optional target language (e.g. "Spanish", "Hindi").
    if (task === 'translate') {
      const lang = (req.body?.lang || '').toString().replace(/[^a-zA-Z \-]/g, '').slice(0, 40).trim();
      if (lang) instruction = `Translate the following text to ${lang}. Return only the translation, nothing else:`;
    }

    const j = await ollama('/api/generate', { prompt: `${instruction}\n\n${text}` });
    res.json({ result: (j.response || '').trim() });
  } catch (err) {
    console.error('[ai assist]', err.message);
    res.status(503).json({ error: 'AI is unavailable right now' });
  }
});

module.exports = router;
