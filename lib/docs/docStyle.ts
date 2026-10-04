// lib/docs/docStyle.ts — what "style" means for a scanned document.
//
// Kept free of expo imports on purpose: lib/docs/pdf.ts pulls in expo-print and
// expo-image-manipulator, which cannot load under tsx, so the parts worth
// testing live here instead.
//
// A style is not decoration. It picks the page it is printed onto — an ID card
// laid out full-bleed on A4 comes out as a poster, which is what makes a scanned
// card useless when someone prints it.

// Type-only: erased at runtime, so this file still loads under tsx.
import type { Ionicons } from '@expo/vector-icons';

export type DocStyleId = 'id' | 'document' | 'letter' | 'report';

export interface DocStyle {
  id: DocStyleId;
  label: string;
  /** Ionicons glyph for the chip. */
  icon: keyof typeof Ionicons.glyphMap;
  /** @page rule for the PDF. */
  page: string;
  /** Width the scanned page is drawn at, inside that page. */
  imageWidth: string;
}

export const DOC_STYLES: DocStyle[] = [
  // 85.6mm is the real ISO/IEC 7810 ID-1 card width, so a printed scan is 1:1.
  { id: 'id',       label: 'ID card',  icon: 'card-outline',          page: 'size: A4; margin: 16mm',     imageWidth: '85.6mm' },
  { id: 'document', label: 'Document', icon: 'document-text-outline', page: 'size: A4; margin: 8mm',      imageWidth: '100%' },
  { id: 'letter',   label: 'Letter',   icon: 'mail-outline',          page: 'size: Letter; margin: 18mm', imageWidth: '100%' },
  { id: 'report',   label: 'Report',   icon: 'bar-chart-outline',     page: 'size: A4; margin: 14mm',     imageWidth: '100%' },
];

export const DEFAULT_STYLE: DocStyleId = 'document';

export function docStyle(id: DocStyleId): DocStyle {
  return DOC_STYLES.find(s => s.id === id) ?? DOC_STYLES[1];
}

/** `ID card 2026-08-26` — what the name field starts with, before the user edits it. */
export function defaultDocName(id: DocStyleId, on: Date): string {
  const d = `${on.getFullYear()}-${String(on.getMonth() + 1).padStart(2, '0')}-${String(on.getDate()).padStart(2, '0')}`;
  return `${docStyle(id).label} ${d}`;
}

/**
 * A filename the user typed, made safe to write and to send.
 * Falls back to the style's default name if they cleared the field entirely.
 */
export function docFilename(name: string, id: DocStyleId, on: Date): string {
  const cleaned = name.replace(/[\\/:*?"<>|]/g, '').trim().replace(/\.pdf$/i, '');
  return `${cleaned || defaultDocName(id, on)}.pdf`;
}
