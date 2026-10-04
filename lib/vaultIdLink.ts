// lib/vaultIdLink.ts — read a VaultID out of a scanned QR payload.
//
// Accepts only what the app itself produces (app/qr-contact.tsx): the
// `vaultchat://add/<id>/<name>` QR (and the `crazzychat` scheme alias), the
// shared `https://vaultchat.app/add/<id>` link, `@id`, or a bare id. Any other
// URL — a `/add/` path on someone else's host included — is not a VaultID.
// Pure (no react-native), so lib/vaultIdLink.selftest.ts runs under tsx.

/** Server ids are 'v' + 12 hex today; allow a bounded, URL-safe superset. */
const VAULT_ID_RE = /^[A-Za-z0-9_.-]{3,64}$/;

const ADD_PREFIXES = ['vaultchat://add/', 'crazzychat://add/', 'https://vaultchat.app/add/'];

/** The VaultID in `data`, or '' when the payload is not one of ours. */
export function parseVaultIdPayload(data: string): string {
  const raw = (data ?? '').trim();
  let id = '';
  const prefix = ADD_PREFIXES.find((p) => raw.toLowerCase().startsWith(p));
  if (prefix) id = raw.slice(prefix.length).split(/[/?#]/)[0];
  else if (/^[a-z][a-z0-9+.-]*:/i.test(raw)) return '';   // some other URL / scheme
  else id = raw;
  id = id.replace(/^@/, '');
  return VAULT_ID_RE.test(id) ? id : '';
}
