/**
 * Shared OOXML helpers: a .docx / .pptx is a ZIP of XML parts, so both parsers
 * unzip in memory and walk the XML. Nothing is written to disk and nothing is
 * uploaded — the file stays inside the vault.
 */
import { unzipSync, strFromU8 } from 'fflate';
import { XMLParser } from 'fast-xml-parser';
import { OfficeParseError } from './types';

export type Zip = Record<string, Uint8Array>;

/** Decode a base64 string to bytes without depending on Buffer. */
export function base64ToBytes(base64: string): Uint8Array {
  const clean = base64.replace(/[\n\r\s]/g, '');
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  const lookup = new Uint8Array(256);
  for (let i = 0; i < chars.length; i++) lookup[chars.charCodeAt(i)] = i;

  let bufferLength = Math.floor((clean.length * 3) / 4);
  if (clean.endsWith('==')) bufferLength -= 2;
  else if (clean.endsWith('=')) bufferLength -= 1;

  const bytes = new Uint8Array(bufferLength);
  let p = 0;
  for (let i = 0; i < clean.length; i += 4) {
    const e1 = lookup[clean.charCodeAt(i)];
    const e2 = lookup[clean.charCodeAt(i + 1)];
    const e3 = lookup[clean.charCodeAt(i + 2)];
    const e4 = lookup[clean.charCodeAt(i + 3)];
    if (p < bufferLength) bytes[p++] = (e1 << 2) | (e2 >> 4);
    if (p < bufferLength) bytes[p++] = ((e2 & 15) << 4) | (e3 >> 2);
    if (p < bufferLength) bytes[p++] = ((e3 & 3) << 6) | (e4 & 63);
  }
  return bytes;
}

export function openZip(base64: string): Zip {
  try {
    return unzipSync(base64ToBytes(base64)) as Zip;
  } catch (e) {
    throw new OfficeParseError('This file is not a readable Office document.', e);
  }
}

export function readEntry(zip: Zip, path: string): string | null {
  const entry = zip[path];
  return entry ? strFromU8(entry) : null;
}

/** All entry paths matching a predicate, in natural (numeric-aware) order. */
export function listEntries(zip: Zip, test: (p: string) => boolean): string[] {
  return Object.keys(zip)
    .filter(test)
    .sort((a, b) => {
      const na = Number(a.match(/(\d+)\D*$/)?.[1] ?? 0);
      const nb = Number(b.match(/(\d+)\D*$/)?.[1] ?? 0);
      return na - nb || a.localeCompare(b);
    });
}

export const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@',
  // Keep whitespace-only runs: Word uses them for spacing between styled runs.
  trimValues: false,
  parseTagValue: false,
  isArray: () => false,
});

export function parseXml(xml: string): any {
  try {
    return parser.parse(xml);
  } catch (e) {
    throw new OfficeParseError('The document XML could not be parsed.', e);
  }
}

/** Normalize a node that may be absent, a single object, or an array. */
export function asArray<T>(v: T | T[] | undefined | null): T[] {
  if (v == null) return [];
  return Array.isArray(v) ? v : [v];
}

/** Depth-first collect of every value under the given tag name. */
export function collectText(node: any, tag: string, out: string[] = []): string[] {
  if (node == null || typeof node !== 'object') return out;
  for (const [key, value] of Object.entries(node)) {
    if (key === tag) {
      for (const v of asArray(value as any)) {
        if (typeof v === 'string') out.push(v);
        else if (v && typeof v === 'object' && typeof (v as any)['#text'] === 'string') out.push((v as any)['#text']);
      }
    }
    if (value && typeof value === 'object') collectText(value, tag, out);
  }
  return out;
}
