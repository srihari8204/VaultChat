// app/file-preview.tsx — File Preview with Syntax Highlighting
// Opens code files, text, JSON, markdown with colored syntax
// Supports: JS, TS, Python, Java, C, Go, Rust, SQL, HTML, CSS, JSON, YAML, MD, TXT
// Dark theme with line numbers

import React, { useState, useEffect } from 'react';
import {
  View, Text, TouchableOpacity, StyleSheet, ScrollView,
  StatusBar, ActivityIndicator, Share, Alert,
} from 'react-native';
import { useLocalSearchParams, Stack } from 'expo-router';
import * as FileSystem from 'expo-file-system/legacy';
import { copyAndAutoClear } from '../lib/clipboardSafe';

const C = { bg: '#FFFFFF', accent: '#4A9FFF', card: '#161B22', green: '#10B981' };

// Syntax color themes per token type
const TOKEN_COLORS = {
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
const LANG_MAP = {
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
const KEYWORDS = {
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
const tokenize = (line, lang) => {
  const tokens = [];
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
      let type = 'default';
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

export default function FilePreviewScreen() {
  const { uri, filename, mediaUrl } = useLocalSearchParams();
  const [content, setContent] = useState('');
  const [loading, setLoading] = useState(true);
  const [lang, setLang] = useState('text');
  const [wordWrap, setWordWrap] = useState(true);

  useEffect(() => {
    const loadFile = async () => {
      try {
        const ext = ((filename || uri || '') + '').split('.').pop()?.toLowerCase() || 'txt';
        setLang(LANG_MAP[ext] || 'text');

        const fileUri = (uri || mediaUrl || '') + '';
        if (fileUri.startsWith('http')) {
          // Download from URL first
          const localPath = FileSystem.cacheDirectory + 'preview_' + Date.now() + '.' + ext;
          await FileSystem.downloadAsync(fileUri, localPath);
          const text = await FileSystem.readAsStringAsync(localPath);
          setContent(text);
        } else if (fileUri) {
          const text = await FileSystem.readAsStringAsync(fileUri);
          setContent(text);
        }
      } catch (e) {
        setContent('// Error loading file: ' + (e.message || 'Unknown error'));
      }
      setLoading(false);
    };
    loadFile();
  }, [filename, uri, mediaUrl]);

  const copyAll = async () => {
    await copyAndAutoClear(content);
    Alert.alert('Copied!', 'File content copied to clipboard');
  };

  const shareFile = async () => {
    await Share.share({ message: content, title: (filename || 'file') + '' });
  };

  const lines = content.split('\n');
  const lineNumWidth = String(lines.length).length * 9 + 16;

  return (
    <>
      <Stack.Screen options={{
        title: (filename || 'Preview') + '',
        headerStyle: { backgroundColor: '#FFFFFF' },
        headerTintColor: '#1F2937',
        headerRight: () => (
          <View style={{ flexDirection: 'row', gap: 12, marginRight: 8 }}>
            <TouchableOpacity onPress={() => setWordWrap(!wordWrap)}>
              <Text style={{ color: wordWrap ? C.accent : '#6B7280', fontSize: 12, fontWeight: '700' }}>Wrap</Text>
            </TouchableOpacity>
            <TouchableOpacity onPress={copyAll}>
              <Text style={{ color: C.accent, fontSize: 12, fontWeight: '700' }}>Copy</Text>
            </TouchableOpacity>
            <TouchableOpacity onPress={shareFile}>
              <Text style={{ color: C.accent, fontSize: 12, fontWeight: '700' }}>Share</Text>
            </TouchableOpacity>
          </View>
        ),
      }} />
      <View style={s.container}>
        <StatusBar barStyle="light-content" />

        {/* File info bar */}
        <View style={s.infoBar}>
          <Text style={s.langBadge}>{lang.toUpperCase()}</Text>
          <Text style={s.lineCount}>{lines.length} lines</Text>
          <Text style={s.sizeInfo}>{(content.length / 1024).toFixed(1)} KB</Text>
        </View>

        {loading ? (
          <ActivityIndicator color={C.accent} style={{ marginTop: 40 }} />
        ) : (
          <ScrollView style={s.codeScroll} horizontal={!wordWrap}>
            <ScrollView nestedScrollEnabled>
              {lines.map((line, idx) => {
                const tokens = tokenize(line, lang);
                return (
                  <View key={idx} style={s.lineRow}>
                    <Text style={[s.lineNum, { width: lineNumWidth }]}>{idx + 1}</Text>
                    <Text style={[s.codeLine, wordWrap && { flexWrap: 'wrap', flex: 1 }]}>
                      {tokens.map((t, ti) => (
                        <Text key={ti} style={{ color: TOKEN_COLORS[t.type] || TOKEN_COLORS.default }}>{t.text}</Text>
                      ))}
                    </Text>
                  </View>
                );
              })}
              <View style={{ height: 100 }} />
            </ScrollView>
          </ScrollView>
        )}
      </View>
    </>
  );
}

const s = StyleSheet.create({
  container: { flex: 1, backgroundColor: C.bg },
  infoBar: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 12, paddingVertical: 8, backgroundColor: C.card, borderBottomWidth: 1, borderBottomColor: '#21262D', gap: 12 },
  langBadge: { backgroundColor: '#4A9FFF22', color: C.accent, fontSize: 10, fontWeight: '800', paddingHorizontal: 8, paddingVertical: 3, borderRadius: 4 },
  lineCount: { color: '#8B949E', fontSize: 11 },
  sizeInfo: { color: '#8B949E', fontSize: 11 },
  codeScroll: { flex: 1 },
  lineRow: { flexDirection: 'row', minHeight: 22 },
  lineNum: { color: '#484F58', fontSize: 12, fontFamily: 'monospace', textAlign: 'right', paddingRight: 12, paddingTop: 2, backgroundColor: '#FFFFFF', borderRightWidth: 1, borderRightColor: '#21262D' },
  codeLine: { fontSize: 12, fontFamily: 'monospace', paddingLeft: 12, paddingTop: 2, color: '#C9D1D9' },
});
