// vaultlens-gen-previews.js — bootstrap the style-preview thumbnails by running
// EACH catalog style against ONE sample face through the same ModelsLab pipeline,
// so every preview is genuinely "this style applied to a sample face" (exactly
// what the Home grid promises). Costs one ModelsLab generation per style.
//
// Run inside the api container (has storage + modelslab + catalog + the key):
//   docker cp vaultlens-gen-previews.js vaultchat-stack-api-1:/app/
//   docker cp sample.jpg               vaultchat-stack-api-1:/tmp/
//   <DC> exec api node vaultlens-gen-previews.js /tmp/sample.jpg
// Options:  SAMPLE_FACE_URL=<public url>   (instead of a local path)
//           ONLY=pro-linkedin,anime-shonen (regenerate just a few)

const fs        = require('fs');
const store     = require('./lib/storage');
const modelslab = require('./lib/modelslab');
const catalog   = require('./vaultlens-catalog.json');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  if (!store.enabled())     { console.error('R2/storage not configured'); process.exit(1); }
  if (!modelslab.enabled()) { console.error('MODELSLAB_API_KEY not set');  process.exit(1); }

  // Sample face → a URL ModelsLab can fetch. A local path is uploaded to R2 and
  // presigned; or pass a public SAMPLE_FACE_URL directly.
  let sampleUrl = process.env.SAMPLE_FACE_URL || '';
  const localPath = process.argv[2];
  if (!sampleUrl && localPath) {
    await store.putObject('vaultlens/previews/_sample.jpg', fs.readFileSync(localPath), 'image/jpeg');
    sampleUrl = await store.presignGet('vaultlens/previews/_sample.jpg', 3600);
  }
  if (!sampleUrl) { console.error('Usage: node vaultlens-gen-previews.js /path/to/sample.jpg   (or set SAMPLE_FACE_URL)'); process.exit(1); }

  const only = process.env.ONLY ? new Set(process.env.ONLY.split(',')) : null;
  const styles = catalog.packs.flatMap((p) => p.styles);
  let ok = 0, fail = 0;
  for (const s of styles) {
    if (only && !only.has(s.id)) continue;
    try {
      const negative = [s.negative, catalog.negativeBase].filter(Boolean).join(', ');
      const params   = { ...(catalog.defaults || {}), ...(s.params || {}) };
      const urls = await modelslab.generate({ prompt: s.prompt, negativePrompt: negative, initImage: sampleUrl, width: 512, height: 512, params });
      await store.putObject(`vaultlens/previews/${s.id}.jpg`, await modelslab.download(urls[0]), 'image/jpeg');
      console.log('OK  ', s.id); ok++;
    } catch (e) { console.error('FAIL', s.id, e.message); fail++; }
    await sleep(2500); // be gentle on the ModelsLab quota
  }
  console.log(`\ndone: ${ok} ok, ${fail} failed`);
  process.exit(fail && !ok ? 1 : 0);
})();
