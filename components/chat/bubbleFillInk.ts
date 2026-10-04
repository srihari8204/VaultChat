// components/chat/bubbleFillInk.ts — moved to lib/bubbleFillInk.ts so lib/
// does not import from components/. This re-export keeps the palette
// selftests and screens that still import this path working.
// ponytail: a re-export shim; delete it once the remaining importers
// (constants/*Palette*.ts, app/chat-themes.tsx, components/notes/noteHueInk.ts)
// import lib/bubbleFillInk directly.
export * from '../../lib/bubbleFillInk';
