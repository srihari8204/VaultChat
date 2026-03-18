const fs = require('fs');
const path = 'C:\\Users\\ADMIN\\Desktop\\Vaultchat backup\\services\\mediaService.ts';

const content = `// services/mediaService.ts
// Upload images, videos, audio, files to Firebase Storage
// Supports ALL file types — .ps1, .java, .py, .txt, .zip, ANY extension

import storage from '@react-native-firebase/storage';

export type MediaType = 'image' | 'video' | 'audio' | 'file';

export interface UploadResult {
  downloadURL: string;
  storagePath: string;
  filename: string;
  mimeType: string;
  size?: number;
}

// Comprehensive MIME type map — covers code files, documents, archives, and more
const MIME_MAP: Record<string, string> = {
  // Code & Scripts
  ps1: 'application/x-powershell',
  java: 'text/x-java-source',
  py: 'text/x-python',
  js: 'application/javascript',
  ts: 'application/typescript',
  tsx: 'application/typescript',
  jsx: 'application/javascript',
  c: 'text/x-c',
  cpp: 'text/x-c++',
  h: 'text/x-c',
  cs: 'text/x-csharp',
  rs: 'text/x-rust',
  go: 'text/x-go',
  rb: 'text/x-ruby',
  php: 'application/x-php',
  swift: 'text/x-swift',
  kt: 'text/x-kotlin',
  dart: 'text/x-dart',
  sh: 'application/x-sh',
  bat: 'application/x-bat',
  cmd: 'application/x-bat',
  sql: 'application/sql',
  r: 'text/x-r',
  lua: 'text/x-lua',
  pl: 'text/x-perl',
  scala: 'text/x-scala',
  // Web
  html: 'text/html',
  htm: 'text/html',
  css: 'text/css',
  scss: 'text/x-scss',
  less: 'text/x-less',
  svg: 'image/svg+xml',
  // Data formats
  json: 'application/json',
  xml: 'application/xml',
  yaml: 'text/yaml',
  yml: 'text/yaml',
  csv: 'text/csv',
  tsv: 'text/tab-separated-values',
  toml: 'text/x-toml',
  ini: 'text/x-ini',
  env: 'text/plain',
  // Documents
  txt: 'text/plain',
  md: 'text/markdown',
  rtf: 'application/rtf',
  pdf: 'application/pdf',
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  ppt: 'application/vnd.ms-powerpoint',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  // Archives
  zip: 'application/zip',
  rar: 'application/x-rar-compressed',
  '7z': 'application/x-7z-compressed',
  tar: 'application/x-tar',
  gz: 'application/gzip',
  bz2: 'application/x-bzip2',
  // Images
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  gif: 'image/gif',
  webp: 'image/webp',
  bmp: 'image/bmp',
  ico: 'image/x-icon',
  tiff: 'image/tiff',
  // Audio
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  m4a: 'audio/mp4',
  aac: 'audio/aac',
  ogg: 'audio/ogg',
  flac: 'audio/flac',
  wma: 'audio/x-ms-wma',
  // Video
  mp4: 'video/mp4',
  mov: 'video/quicktime',
  avi: 'video/x-msvideo',
  mkv: 'video/x-matroska',
  webm: 'video/webm',
  flv: 'video/x-flv',
  wmv: 'video/x-ms-wmv',
  // Apps
  apk: 'application/vnd.android.package-archive',
  ipa: 'application/octet-stream',
  exe: 'application/x-msdownload',
  dmg: 'application/x-apple-diskimage',
  msi: 'application/x-msi',
  deb: 'application/x-deb',
  rpm: 'application/x-rpm',
  // Database
  db: 'application/x-sqlite3',
  sqlite: 'application/x-sqlite3',
  // Fonts
  ttf: 'font/ttf',
  otf: 'font/otf',
  woff: 'font/woff',
  woff2: 'font/woff2',
  // Config
  log: 'text/plain',
  cfg: 'text/plain',
  conf: 'text/plain',
  properties: 'text/plain',
  gitignore: 'text/plain',
  dockerfile: 'text/plain',
};

function getMimeType(filename: string, type: MediaType): string {
  const ext = filename.split('.').pop()?.toLowerCase() ?? '';
  if (MIME_MAP[ext]) return MIME_MAP[ext];
  if (type === 'image') return 'image/jpeg';
  if (type === 'video') return 'video/mp4';
  if (type === 'audio') return 'audio/m4a';
  return 'application/octet-stream';
}

// Upload any local file URI to Firebase Storage
// NO file type restrictions, NO size cap
export async function uploadMedia(
  localUri: string,
  chatId: string,
  type: MediaType,
  filename?: string,
  onProgress?: (pct: number) => void
): Promise<UploadResult> {
  const ext  = localUri.split('.').pop()?.toLowerCase() ?? 'bin';
  const name = filename ?? \\\`\\\${type}_\\\${Date.now()}.\\\${ext}\\\`;
  const path = \\\`chats/\\\${chatId}/\\\${type}s/\\\${name}\\\`;
  const ref  = storage().ref(path);

  const task = ref.putFile(localUri);

  if (onProgress) {
    task.on('state_changed', snap => {
      const pct = (snap.bytesTransferred / snap.totalBytes) * 100;
      onProgress(Math.round(pct));
    });
  }

  await task;
  const downloadURL = await ref.getDownloadURL();
  const mimeType = getMimeType(name, type);

  return { downloadURL, storagePath: path, filename: name, mimeType };
}

// Delete a file from Firebase Storage by its storagePath
export async function deleteMedia(storagePath: string): Promise<void> {
  try {
    await storage().ref(storagePath).delete();
  } catch { /* ignore if already deleted */ }
}

// Helper: Get a display-friendly icon emoji for any file extension
export function getFileIcon(filename: string): string {
  const ext = filename.split('.').pop()?.toLowerCase() ?? '';
  const codeExts = ['ps1','java','py','js','ts','tsx','jsx','c','cpp','h','cs','rs','go','rb','php','swift','kt','dart','sh','bat','cmd','sql','r','lua','pl','scala'];
  const webExts = ['html','htm','css','scss','less','svg'];
  const dataExts = ['json','xml','yaml','yml','csv','tsv','toml','ini','env'];
  const docExts = ['txt','md','rtf','log','cfg','conf'];
  const officeDoc = ['doc','docx'];
  const officeSheet = ['xls','xlsx'];
  const officeSlide = ['ppt','pptx'];
  const archiveExts = ['zip','rar','7z','tar','gz','bz2'];
  const audioExts = ['mp3','wav','m4a','aac','ogg','flac','wma'];
  const videoExts = ['mp4','mov','avi','mkv','webm','flv','wmv'];
  const imgExts = ['jpg','jpeg','png','gif','webp','bmp','ico','tiff'];
  const appExts = ['apk','ipa','exe','dmg','msi','deb','rpm'];
  const dbExts = ['db','sqlite'];
  if (ext === 'pdf') return '📄';
  if (codeExts.includes(ext)) return '💻';
  if (webExts.includes(ext)) return '🌐';
  if (dataExts.includes(ext)) return '📊';
  if (docExts.includes(ext)) return '📝';
  if (officeDoc.includes(ext)) return '📃';
  if (officeSheet.includes(ext)) return '📊';
  if (officeSlide.includes(ext)) return '📊';
  if (archiveExts.includes(ext)) return '📦';
  if (audioExts.includes(ext)) return '🎵';
  if (videoExts.includes(ext)) return '🎬';
  if (imgExts.includes(ext)) return '🖼️';
  if (appExts.includes(ext)) return '⚙️';
  if (dbExts.includes(ext)) return '🗄️';
  return '📁';
}

// Helper: Get human-readable file type label
export function getFileTypeLabel(filename: string): string {
  const ext = filename.split('.').pop()?.toLowerCase() ?? '';
  const labels: Record<string, string> = {
    ps1:'PowerShell', java:'Java', py:'Python', js:'JavaScript', ts:'TypeScript',
    tsx:'React TSX', jsx:'React JSX', c:'C Source', cpp:'C++', cs:'C#',
    rs:'Rust', go:'Go', rb:'Ruby', php:'PHP', swift:'Swift', kt:'Kotlin',
    dart:'Dart', sh:'Shell', bat:'Batch', sql:'SQL', r:'R Script',
    html:'HTML', css:'CSS', json:'JSON', xml:'XML', yaml:'YAML', csv:'CSV',
    txt:'Text', md:'Markdown', pdf:'PDF', doc:'Word', docx:'Word',
    xls:'Excel', xlsx:'Excel', ppt:'PowerPoint', pptx:'PowerPoint',
    zip:'ZIP Archive', rar:'RAR Archive', '7z':'7-Zip', tar:'TAR',
    apk:'Android APK', exe:'Executable', dmg:'macOS DMG',
    mp3:'MP3 Audio', mp4:'MP4 Video', mov:'QuickTime',
    db:'Database', sqlite:'SQLite',
  };
  return labels[ext] ?? ext.toUpperCase() + ' File';
}
`;

fs.writeFileSync(path, content, 'utf8');
console.log('mediaService.ts updated with 100+ MIME types + getFileIcon + getFileTypeLabel');