// lib/modelslab.js — ModelsLab image-generation client for VaultLens.
//
// The API key lives ONLY here (server-side, from env) — it never reaches the
// client. `generate()` applies a style prompt to the user's cached face
// reference (img2img) and returns the output image URL(s); ModelsLab async jobs
// ('processing') are polled to completion. `download()` fetches the result bytes
// so the worker can re-host them in our own R2 (private, 24h lifecycle).
//
// Env:
//   MODELSLAB_API_KEY         required — enables generation (else 'not_configured')
//   MODELSLAB_ENDPOINT        default https://modelslab.com/api/v6/images/img2img
//   MODELSLAB_FETCH_ENDPOINT  default https://modelslab.com/api/v6/images/fetch

const ENDPOINT       = process.env.MODELSLAB_ENDPOINT       || 'https://modelslab.com/api/v6/images/img2img';
const FETCH_ENDPOINT = process.env.MODELSLAB_FETCH_ENDPOINT || 'https://modelslab.com/api/v6/images/fetch';

const key = () => process.env.MODELSLAB_API_KEY || '';
function enabled() { return !!key(); }

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function post(url, body) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  return { ok: res.ok, json };
}

// Apply a style to a face reference. Returns an array of output image URLs.
async function generate({ prompt, negativePrompt, initImage, width = 512, height = 512, params = {} }) {
  if (!enabled()) { const e = new Error('ModelsLab not configured'); e.code = 'not_configured'; throw e; }
  const body = {
    key: key(),
    // MODELSLAB_MODEL (env) overrides everything so one valid model can be set
    // account-wide without a code change; per-style params.model_id is next; then
    // the built-in default. The style PROMPT still differentiates the look.
    model_id: process.env.MODELSLAB_MODEL || params.model_id || 'realistic-vision-v6',
    prompt,
    negative_prompt: negativePrompt || '',
    init_image: initImage,
    width: String(width),
    height: String(height),
    samples: String(params.samples || 1),
    num_inference_steps: String(params.num_inference_steps || 30),
    guidance_scale: params.guidance_scale ?? 7.5,
    strength: params.strength ?? 0.55,
    scheduler: params.scheduler || 'DPMSolverMultistepScheduler',
    safety_checker: 'yes',
    base64: 'no',
  };

  const { ok, json } = await post(ENDPOINT, body);
  const status = json?.status;
  if (status === 'error' || (!ok && status !== 'processing')) {
    const e = new Error(json?.message || json?.messege || `ModelsLab HTTP error`);
    e.code = 'provider_error';
    throw e;
  }

  let output = json?.output;
  if (status === 'processing' && (json?.id || json?.request_id)) {
    output = await pollFetch(json.id || json.request_id, Number(json?.eta) || 8);
  }
  if (!Array.isArray(output) || output.length === 0) {
    const e = new Error('ModelsLab returned no image'); e.code = 'empty'; throw e;
  }
  return output;
}

// Poll the async fetch endpoint until the job resolves (or ~2 min timeout).
async function pollFetch(id, etaSec) {
  const start = Date.now();
  const MAX = 120_000;
  await sleep(Math.min(Math.max((etaSec || 8) * 1000, 2000), 15000));
  while (Date.now() - start < MAX) {
    const { json } = await post(FETCH_ENDPOINT, { key: key(), request_id: id });
    if (json?.status === 'success' && Array.isArray(json.output) && json.output.length) return json.output;
    if (json?.status === 'error') { const e = new Error(json?.message || 'fetch error'); e.code = 'provider_error'; throw e; }
    await sleep(3000);
  }
  const e = new Error('ModelsLab timed out'); e.code = 'timeout'; throw e;
}

// Download a generated image URL → Buffer (to re-host in our private R2).
async function download(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`download failed (${res.status})`);
  return Buffer.from(await res.arrayBuffer());
}

module.exports = { enabled, generate, download };
