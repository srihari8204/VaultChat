// app/file-preview.tsx — File Preview with Syntax Highlighting
// Opens code files, text, JSON, markdown with colored syntax
// Supports: JS, TS, Python, Java, C, Go, Rust, SQL, HTML, CSS, JSON, YAML, MD, TXT
// Dark theme with line numbers

import React, { useState, useEffect, useMemo, useCallback } from 'react';
import { View, Text, TouchableOpacity, StyleSheet, ScrollView, FlatList, ActivityIndicator, Alert } from 'react-native';
import * as Sharing from 'expo-sharing';
import { type Palette, brandAlpha } from '../constants/theme';
import { useTheme } from '../lib/theme';
import { useLocalSearchParams, Stack, useRouter } from 'expo-router';
import * as FileSystem from 'expo-file-system/legacy';
import { copyAndAutoClear } from '../lib/clipboardSafe';
import { getAccessToken } from '../lib/api';
import { isOwnServerUrl } from '../lib/serverOrigin';
import { VIEWER_TEMP_PREFIX } from '../lib/mediaCacheGC';

/** Whole-file read + tokenised lines: past this, the windowed file-viewer reads it. */
const MAX_PREVIEW_BYTES = 2 * 1024 * 1024;


// Syntax color themes per token type
type TokenType = 'keyword' | 'string' | 'comment' | 'number' | 'function' | 'type' | 'operator'
  | 'property' | 'tag' | 'attribute' | 'punctuation' | 'default';
type Token = { text: string; type: TokenType };

const TOKEN_COLORS: Record<TokenType, string> = {
  keyword: '#FF7B72',
  string: '#A5D6FF',
  comment: '#8B949E',
  number: '#79C0FF',
  function: '#D2A8FF',
  type: '#FFA657',
  operator: '#FF7B72',
  property: '#79C0FF',
  tag: '#7EE787',
  attribute: '#79C0FF',
  punctuation: '#C9D1D9',
  default: '#C9D1D9',
};

// Language detection from extension
const LANG_MAP: Record<string, string> = {
  js: 'javascript', jsx: 'javascript', ts: 'typescript', tsx: 'typescript',
  py: 'python', java: 'java', c: 'c', cpp: 'cpp', h: 'c',
  cs: 'csharp', go: 'go', rs: 'rust', rb: 'ruby', php: 'php',
  swift: 'swift', kt: 'kotlin', dart: 'dart', sql: 'sql',
  html: 'html', htm: 'html', css: 'css', scss: 'css',
  json: 'json', yaml: 'yaml', yml: 'yaml', xml: 'xml',
  md: 'markdown', txt: 'text', sh: 'bash', bat: 'bash',
  ps1: 'powershell', r: 'r', lua: 'lua', pl: 'perl',
  toml: 'toml', ini: 'ini', env: 'ini', csv: 'text',
};

// Keywords per language
const KEYWORDS: Record<string, string[]> = {
  javascript: ['const','let','var','function','return','if','else','for','while','switch','case','break','continue','new','this','class','extends','import','export','from','default','async','await','try','catch','throw','typeof','instanceof','null','undefined','true','false','of','in'],
  typescript: ['const','let','var','function','return','if','else','for','while','switch','case','break','continue','new','this','class','extends','import','export','from','default','async','await','try','catch','throw','typeof','instanceof','null','undefined','true','false','interface','type','enum','implements','readonly','as','keyof','never','void','any','string','number','boolean','of','in'],
  python: ['def','class','if','elif','else','for','while','return','import','from','as','try','except','finally','raise','with','yield','lambda','pass','break','continue','and','or','not','in','is','None','True','False','self','print','global','nonlocal','assert','del'],
  java: ['public','private','protected','static','final','void','class','interface','extends','implements','new','return','if','else','for','while','switch','case','break','continue','try','catch','throw','throws','import','package','this','super','null','true','false','int','long','double','float','boolean','String','char','byte'],
  go: ['func','package','import','return','if','else','for','range','switch','case','break','continue','var','const','type','struct','interface','map','chan','go','defer','select','default','nil','true','false','string','int','bool','error','fmt'],
  rust: ['fn','let','mut','if','else','for','while','loop','match','return','use','mod','pub','struct','enum','impl','trait','where','self','Self','true','false','String','Vec','Option','Result','Some','None','Ok','Err','async','await','move','ref','as','in'],
  sql: ['SELECT','FROM','WHERE','INSERT','INTO','VALUES','UPDATE','SET','DELETE','CREATE','TABLE','ALTER','DROP','INDEX','JOIN','LEFT','RIGHT','INNER','OUTER','ON','AND','OR','NOT','NULL','AS','ORDER','BY','GROUP','HAVING','LIMIT','OFFSET','DISTINCT','COUNT','SUM','AVG','MAX','MIN','LIKE','IN','BETWEEN','EXISTS','UNION','ALL','PRIMARY','KEY','FOREIGN','REFERENCES'],
  html: ['html','head','body','div','span','p','a','img','ul','ol','li','table','tr','td','th','form','input','button','script','style','link','meta','title','header','footer','nav','section','article','main','h1','h2','h3','h4','h5','h6','class','id','href','src','type','name','value'],
  css: ['color','background','margin','padding','border','font','display','position','width','height','flex','grid','align','justify','text','overflow','opacity','transform','transition','animation','z-index','box-shadow','border-radius','cursor','content','@media','@import','@keyframes','!important'],
  json: [],
  markdown: [],
  text: [],
  bash: ['echo','if','then','else','fi','for','do','done','while','case','esac','function','return','exit','export','source','cd','ls','mkdir','rm','cp','mv','cat','grep','sed','awk','chmod','chown','sudo','apt','npm','node','git','docker'],
  powershell: ['function','param','if','else','elseif','foreach','for','while','switch','return','try','catch','finally','throw','Write-Host','Write-Output','Get-Content','Set-Content','Get-ChildItem','Copy-Item','Remove-Item','New-Item','Select-Object','Where-Object','ForEach-Object','Import-Module','Install-Module'],
};

// Simple tokenizer
const tokenize = (line: string, lang: string): Token[] => {
  const tokens: Token[] = [];
  const kw = KEYWORDS[lang] || KEYWORDS.javascript || [];
  let i = 0;

  while (i < line.length) {
    // Comments
    if (line.slice(i, i + 2) === '//' || line[i] === '#' && ['python', 'bash', 'ruby', 'yaml', 'ini'].includes(lang)) {
      tokens.push({ text: line.slice(i), type: 'comment' });
      break;
    }

    // Strings
    if (line[i] === '"' || line[i] === "'" || line[i] === '`') {
      const quote = line[i];
      let j = i + 1;
      while (j < line.length && line[j] !== quote) { if (line[j] === '\\') j++; j++; }
      tokens.push({ text: line.slice(i, j + 1), type: 'string' });
      i = j + 1;
      continue;
    }

    // Numbers
    if (/[0-9]/.test(line[i]) && (i === 0 || /[^a-zA-Z_]/.test(line[i - 1]))) {
      let j = i;
      while (j < line.length && /[0-9.xXa-fA-F]/.test(line[j])) j++;
      tokens.push({ text: line.slice(i, j), type: 'number' });
      i = j;
      continue;
    }

    // Words (keywords, functions, identifiers)
    if (/[a-zA-Z_$@]/.test(line[i])) {
      let j = i;
      while (j < line.length && /[a-zA-Z0-9_$]/.test(line[j])) j++;
      const word = line.slice(i, j);
      let type: TokenType = 'default';
      if (kw.includes(word) || kw.includes(word.toLowerCase())) type = 'keyword';
      else if (j < line.length && line[j] === '(') type = 'function';
      else if (/^[A-Z]/.test(word) && word.length > 1) type = 'type';
      tokens.push({ text: word, type });
      i = j;
      continue;
    }

    // Operators
    if (/[+\-*/%=<>!&|^~?:]/.test(line[i])) {
      tokens.push({ text: line[i], type: 'operator' });
      i++;
      continue;
    }

    // Punctuation
    if (/[{}()\[\],.;]/.test(line[i])) {
      tokens.push({ text: line[i], type: 'punctuation' });
      i++;
      continue;
    }

    // Default
    tokens.push({ text: line[i], type: 'default' });
    i++;
  }

  return tokens;
};

function useS() {
  const { colors } = useTheme();
  return useMemo(() => makeStyles(colors), [colors]);
}

export default function FilePreviewScreen() {
  const { colors } = useTheme();
  const s = useS();
  const router = useRouter();
  const { uri, filename, mediaUrl } = useLocalSearchParams();
  const [content, setContent] = useState('');
  const [loading, setLoading] = useState(true);
  const [lang, setLang] = useState('text');
  const [wordWrap, setWordWrap] = useState(true);
  // 'error' and 'too-large' replace the old "error message as file content".
  const [failure, setFailure] = useState<null | 'error' | 'too-large'>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const fileUri = (uri || mediaUrl || '') + '';

  useEffect(() => {
    let dead = false;
    const loadFile = async () => {
      let tmp: string | null = null;
      setLoading(true);
      setFailure(null);
      try {
        const ext = ((filename || uri || '') + '').split('.').pop()?.toLowerCase() || 'txt';
        setLang(LANG_MAP[ext] || 'text');

        let local = fileUri;
        if (fileUri.startsWith('http')) {
          // Our attachment endpoints need the bearer token; never send it to
          // any other host.
          tmp = FileSystem.cacheDirectory + VIEWER_TEMP_PREFIX + 'preview_' + Date.now() + '.' + ext;
          const token = isOwnServerUrl(fileUri) ? await getAccessToken() : null;
          const res = await FileSystem.downloadAsync(fileUri, tmp,
            token ? { headers: { Authorization: `Bearer ${token}` } } : undefined);
          if (res.status >= 400) throw new Error('GET ' + res.status);
          local = tmp;
        }
        if (!local) throw new Error('no file');
        const info = await FileSystem.getInfoAsync(local);
        if (info.exists && info.size > MAX_PREVIEW_BYTES) {
          if (!dead) setFailure('too-large');
          return;
        }
        const text = await FileSystem.readAsStringAsync(local);
        if (!dead) setContent(text);
      } catch (e: any) {
        console.warn('[file-preview] load failed:', e?.message ?? e);
        if (!dead) setFailure('error');
      } finally {
        // The downloaded copy is plaintext and already in memory: don't keep it.
        if (tmp) FileSystem.deleteAsync(tmp, { idempotent: true }).catch(() => {});
        if (!dead) setLoading(false);
      }
    };
    loadFile();
    return () => { dead = true; };
  }, [filename, uri, fileUri, reloadKey]);

  const copyAll = async () => {
    try {
      await copyAndAutoClear(content);
      Alert.alert('Copied!', 'File content copied to clipboard');
    } catch {
      Alert.alert('Could not copy', 'The file content could not be copied. Please try again.');
    }
  };

  // Share the FILE (its name, its type) — not its text pasted into a message,
  // which lost the filename and broke anything that is not plain prose. A local
  // file goes as itself; a downloaded one was not kept (plaintext), so its text
  // is written to a vt_share_ copy that lib/mediaCacheGC sweeps at boot/logout
  // — the receiving app may still be reading it after the sheet closes.
  const [sharing, setSharing] = useState(false);
  const shareFile = async () => {
    if (sharing) return;
    setSharing(true);
    try {
      if (!(await Sharing.isAvailableAsync())) {
        Alert.alert('Sharing unavailable', 'No app on this device can receive this file.');
        return;
      }
      const name = ((filename || 'file') + '').replace(/[/\\:*?"<>|]/g, '_');
      let local = fileUri;
      if (!/^file:/i.test(fileUri)) {
        const dir = FileSystem.cacheDirectory + VIEWER_TEMP_PREFIX + 'share_' + Date.now() + '/';
        await FileSystem.makeDirectoryAsync(dir, { intermediates: true });
        local = dir + name;
        await FileSystem.writeAsStringAsync(local, content);
      }
      await Sharing.shareAsync(local, { dialogTitle: name });
    } catch {
      Alert.alert('Could not share', 'The file could not be shared. Please try again.');
    } finally {
      setSharing(false);
    }
  };

  const lines = useMemo(() => content.split('\n'), [content]);
  // Tokenise LAZILY, per row, and remember it: a 2 MB file is tens of
  // thousands of lines, and tokenising all of them up front held the first
  // paint for the whole file. The cache is per file and language, so a row
  // scrolled back into the window is not tokenised twice.
  // eslint-disable-next-line react-hooks/exhaustive-deps -- a new file or language starts a new cache
  const tokenCache = useMemo(() => new Map<number, Token[]>(), [lines, lang]);
  const tokensAt = useCallback((idx: number): Token[] => {
    let tk = tokenCache.get(idx);
    if (!tk) { tk = tokenize(lines[idx] ?? '', lang); tokenCache.set(idx, tk); }
    return tk;
  }, [tokenCache, lines, lang]);
  const lineNumWidth = String(lines.length).length * 9 + 16;
  const actionsOff = !!failure || loading;

  const codeList = (
    <FlatList
      style={s.codeScroll}
      data={lines}
      keyExtractor={(_, idx) => String(idx)}
      initialNumToRender={60}
      windowSize={11}
      ListFooterComponent={<View style={s.listTail} />}
      renderItem={({ index: idx }) => (
        <View style={s.lineRow}>
          <Text style={[s.lineNum, { width: lineNumWidth }]}>{idx + 1}</Text>
          <Text style={[s.codeLine, wordWrap && s.codeLineWrap]}>
            {tokensAt(idx).map((t, ti) => (
              <Text key={ti} style={{ color: TOKEN_COLORS[t.type] }}>{t.text}</Text>
            ))}
          </Text>
        </View>
      )}
    />
  );

  return (
    <>
      <Stack.Screen options={{
        headerShown: true, /* the root Stack sets headerShown:false app-wide, so the options below were inert and this screen had no back control at all */ 
        title: (filename || 'Preview') + '',
        headerStyle: { backgroundColor: colors.surfaceSolid },
        headerTintColor: colors.text,
        headerRight: () => (
          <View style={s.headerActions}>
            <TouchableOpacity style={s.headerBtn} onPress={() => setWordWrap(!wordWrap)}
              accessibilityRole="switch" accessibilityLabel="Wrap lines" accessibilityState={{ checked: wordWrap }}>
              <Text style={[s.headerBtnTxt, !wordWrap && s.headerBtnOff]}>Wrap</Text>
            </TouchableOpacity>
            <TouchableOpacity style={s.headerBtn} onPress={copyAll} disabled={actionsOff}
              accessibilityRole="button" accessibilityLabel="Copy file contents" accessibilityState={{ disabled: actionsOff }}>
              <Text style={[s.headerBtnTxt, actionsOff && s.headerBtnOff]}>Copy</Text>
            </TouchableOpacity>
            <TouchableOpacity style={s.headerBtn} onPress={shareFile} disabled={actionsOff || sharing}
              accessibilityRole="button" accessibilityLabel="Share file"
              accessibilityState={{ disabled: actionsOff || sharing, busy: sharing }}>
              {sharing ? <ActivityIndicator color={colors.accent} size="small" />
                : <Text style={[s.headerBtnTxt, actionsOff && s.headerBtnOff]}>Share</Text>}
            </TouchableOpacity>
          </View>
        ),
      }} />
      <View style={s.container}>

        {/* File info bar — only once there is content to describe. */}
        {!loading && !failure && (
          <View style={s.infoBar}>
            <Text style={s.langBadge}>{lang.toUpperCase()}</Text>
            <Text style={s.lineCount}>{lines.length} lines</Text>
            <Text style={s.sizeInfo}>{(content.length / 1024).toFixed(1)} KB</Text>
          </View>
        )}

        {loading ? (
          <ActivityIndicator color={colors.accent} style={s.spinner} />
        ) : failure ? (
          <View style={s.failure}>
            <Text style={s.failureTitle} accessibilityRole="header">
              {failure === 'too-large' ? 'Too large to preview here' : "Couldn't load this file"}
            </Text>
            <Text style={s.failureBody}>
              {failure === 'too-large'
                ? 'Open it in the file viewer, which reads large files a page at a time.'
                : 'Check your connection and try again.'}
            </Text>
            <TouchableOpacity
              style={s.failureBtn}
              accessibilityRole="button"
              accessibilityLabel={failure === 'too-large' ? 'Open in file viewer' : 'Retry'}
              onPress={() => (failure === 'too-large'
                ? router.replace({ pathname: '/file-viewer', params: { uri: fileUri, filename: (filename || '') + '' } })
                : setReloadKey(k => k + 1))}
            >
              <Text style={s.failureBtnTxt}>{failure === 'too-large' ? 'Open in file viewer' : 'Retry'}</Text>
            </TouchableOpacity>
          </View>
        ) : (
          // Virtualised: every line used to be tokenised and mounted at once.
          // Wrapped text scrolls vertically only, so the list is the scroller;
          // unwrapped lines get a horizontal ScrollView around it (a vertical
          // list inside a vertical ScrollView would not virtualise).
          wordWrap ? codeList : (
            <ScrollView style={s.codeScroll} horizontal>{codeList}</ScrollView>
          )
        )}
      </View>
    </>
  );
}

const makeStyles = (c: Palette) => StyleSheet.create({
  container: { flex: 1, backgroundColor: c.bg },
  infoBar: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 12, paddingVertical: 8, backgroundColor: c.surfaceSolid, borderBottomWidth: 1, borderBottomColor: c.glassStroke, gap: 12 },
  langBadge: { backgroundColor: brandAlpha(0.14), color: c.accentOn, fontSize: 12, fontWeight: '800', paddingHorizontal: 8, paddingVertical: 3, borderRadius: 4 },
  lineCount: { color: c.textDim, fontSize: 11 },
  sizeInfo: { color: c.textDim, fontSize: 11 },
  // Syntax tokens use a fixed dark canvas; chrome follows the app theme.
  codeScroll: { flex: 1, backgroundColor: '#0D1117' },
  lineRow: { flexDirection: 'row', minHeight: 22 },
  lineNum: { color: '#8B949E', fontSize: 12, fontFamily: 'monospace', textAlign: 'right', paddingRight: 12, paddingTop: 2, backgroundColor: '#161B22', borderRightWidth: 1, borderRightColor: '#21262D' },
  codeLine: { fontSize: 12, fontFamily: 'monospace', paddingLeft: 12, paddingTop: 2, color: '#C9D1D9' },
  failure: { alignItems: 'center', padding: 32, gap: 10 },
  failureTitle: { color: c.text, fontSize: 16, fontWeight: '700', textAlign: 'center' },
  failureBody: { color: c.textDim, fontSize: 13, textAlign: 'center', lineHeight: 19 },
  failureBtn: { marginTop: 6, paddingHorizontal: 20, paddingVertical: 10, borderRadius: 20, backgroundColor: c.accent },
  failureBtnTxt: { color: c.onPrimary, fontSize: 14, fontWeight: '700' },
  headerActions: { flexDirection: 'row', gap: 12, marginRight: 8 },
  headerBtn: { minHeight: 44, justifyContent: 'center' },
  headerBtnTxt: { color: c.accentOn, fontSize: 12, fontWeight: '700' },
  headerBtnOff: { color: c.textDim },
  codeLineWrap: { flexWrap: 'wrap', flex: 1 },
  listTail: { height: 100 },
  spinner: { marginTop: 40 },
});
