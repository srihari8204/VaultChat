// Driven by interop_test.go — verifies Go-produced vault values against the
// real Node lib/vault.js and emits Node-produced values for Go to verify.
// argv[2] = absolute path to vaultchat-backend/lib/vault.js. stdin/stdout: JSON.
const vault = require(process.argv[2]);
const crypto = require('crypto');

(async () => {
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  const g = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  const errors = [];
  const check = (name, fn) => {
    try { if (fn() !== true) errors.push(name); }
    catch (e) { errors.push(`${name}: ${e.message}`); }
  };

  check('node decrypt(goEnvelope)', () => vault.decrypt(g.goEnvelope) === g.plain);
  check('node verifyTicket(goTicket)', () => vault.verifyTicket(g.goTicket, g.ticketData));
  check('emailLookup parity', () => vault.emailLookup(g.email) === g.goEmailLookup);
  check('phoneLookup parity', () => vault.phoneLookup(g.phone) === g.goPhoneLookup);
  check('discoveryHash parity', () => vault.discoveryHash(g.clientSha) === g.goDiscovery);
  try {
    if (!(await vault.verifySecret(g.secret, g.goPhc))) errors.push('node verifySecret(goPhc)');
    if (await vault.verifySecret('wrong-' + g.secret, g.goPhc)) errors.push('node verifySecret accepted wrong secret');
  } catch (e) { errors.push('node verifySecret(goPhc): ' + e.message); }

  // decryptWithKey fixture: iv(12) ‖ ct ‖ tag(16) under an explicit key.
  const kbKey = crypto.randomBytes(32);
  const kbIv = crypto.randomBytes(12);
  const kbPlain = crypto.randomBytes(48);
  const c = crypto.createCipheriv('aes-256-gcm', kbKey, kbIv);
  const ct = Buffer.concat([c.update(kbPlain), c.final()]);
  const blob = Buffer.concat([kbIv, ct, c.getAuthTag()]);

  process.stdout.write(JSON.stringify({
    errors,
    nodeEnvelope: vault.encrypt(g.plain),
    nodePhc: await vault.hashSecret(g.secret),
    nodeTicket: vault.signTicket(g.ticketData, 900),
    kbBlobB64: blob.toString('base64'),
    kbKeyHex: kbKey.toString('hex'),
    kbPlainB64: kbPlain.toString('base64'),
  }));
})().catch((e) => { console.error(e); process.exit(1); });
