// lib/serverOrigin.ts — is a URL on our own API server?
//
// The bearer token may only be attached to requests for SERVER_URL. Viewer
// routes take their URL from route params (deep links included), so a plain
// "is it http(s)?" check would hand the token to whatever host a link names.
// A bare startsWith(SERVER_URL) is not enough either: it also accepts
// "https://api.example.com.evil.net" and "https://api.example.com@evil.net".

import { SERVER_URL } from '../constants/server';

/** True only when `url` is SERVER_URL itself or a path/query under it. */
export function isOwnServerUrl(url: string, server: string = SERVER_URL): boolean {
  const base = server.replace(/\/+$/, '').toLowerCase();
  if (!url || !base) return false;
  if (url.slice(0, base.length).toLowerCase() !== base) return false;
  const next = url.charAt(base.length);
  return next === '' || next === '/' || next === '?' || next === '#';
}
