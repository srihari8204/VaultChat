import { Buffer } from 'buffer';

/** Local routing identity only; the server still verifies the JWT signature. */
export function tokenSubject(token: string | null): string {
  try {
    const body = token?.split('.')[1];
    if (!body) return '';
    const payload = JSON.parse(Buffer.from(body.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'));
    return typeof payload?.sub === 'string' ? payload.sub : '';
  } catch { return ''; }
}
