// lib/chatTimeline.selftest.ts — run: npx tsx lib/chatTimeline.selftest.ts
// Guards the large-history path without importing the React Native screen.

import { readFileSync } from 'node:fs';

// app/chat.tsx was split into components/chat/*; read the screen and its parts as one source.
const chat = ['app/chat.tsx', 'components/chat/ChatHeader.tsx', 'components/chat/InChatSearchBar.tsx', 'components/chat/ChatBanners.tsx', 'components/chat/MessageRow.tsx', 'components/chat/ComposerBars.tsx', 'components/chat/Composer.tsx', 'components/chat/ChatModals.tsx', 'components/chat/MediaCaptionPreview.tsx', 'components/chat/ChatLockGate.tsx', 'components/chat/useChatMenu.ts', 'components/chat/useMessageActions.ts', 'components/chat/useMessagePaging.ts', 'components/chat/useVoiceRecording.ts', 'components/chat/useTiltReveal.ts', 'components/chat/useMediaStaging.ts'].map((f) => readFileSync(f, 'utf8')).join('\n');
const bubble = readFileSync('components/chat/MessageBubble.tsx', 'utf8');
const localDb = readFileSync('lib/localDb.ts', 'utf8');
const chatService = readFileSync('lib/chatService.ts', 'utf8');
const inChatSearch = readFileSync('app/in-chat-search.tsx', 'utf8');
let failures = 0;
const check = (name: string, ok: boolean) => {
  if (!ok) failures++;
  console.log(`  ${ok ? '✓' : '✗'} ${name}`);
};

console.log('\nChat timeline paging\n');
check('first paint stays at 50 messages', /const INITIAL_PAGE_SIZE = 50;/.test(chat));
check('scroll pages use 100 messages', /const SCROLL_PAGE_SIZE = 100;/.test(chat));
check('the second 50 is deferred until interactions finish',
  /InteractionManager\.runAfterInteractions[\s\S]*?getCachedMessagesBefore\(cid, Number\(oldest\), PREFETCH_PAGE_SIZE\)/.test(chat));
check('pagination takes a synchronous lock before its first await',
  chat.indexOf('pagingChatRef.current = cid;', chat.indexOf('const onEndReached')) <
  chat.indexOf('await getCachedMessagesBefore', chat.indexOf('const onEndReached')));
check('cached first paint merges arrivals only for the same pane',
  /messagesChatRef\.current === chatId \? prev : \[\]/.test(chat));
check('a changed search invalidates in-flight results before debounce',
  /const seq = \+\+reqSeq\.current;[\s\S]*?const term = query\.trim\(\)/.test(inChatSearch));
check('cold jumps wait until the initial local page has painted',
  /if \(loading\) return;[\s\S]*?consumePendingJump\(chatId\)/.test(chat));
check('jump paging shares the synchronous paging lock',
  /while \(pagingChatRef\.current && alive\(\)\)[\s\S]*?pagingChatRef\.current = cid;[\s\S]*?finally/.test(chat));
check('imported rows cannot disguise a short positive cache page',
  /cachedPositiveCount < SCROLL_PAGE_SIZE/.test(chat) &&
  /\.sort\(\(a, b\) => Number\(b\.id\) - Number\(a\.id\)\)/.test(chat));
check('failed prefetches can retry without an unhandled rejection',
  /catch \{[\s\S]*?prefetchedChatRef\.current = null;[\s\S]*?finally/.test(chat));
check('pane swaps reset paging UI and prefetch ownership',
  /setLoadingOlder\(false\);[\s\S]*?setHasMore\(true\);[\s\S]*?prefetchedChatRef\.current = null;/.test(chat));
check('partial positive-id caches remain pageable from the server',
  /setHasMore\(localOlder \|\| Number\(oldestCached\) > 0\)/.test(chat));
check('deep jumps use the indexed centred local query before page walking',
  chat.indexOf('getCachedMessagesAround(cid, targetId') < chat.indexOf('while (idx < 0 && guard < maxJumpPages)'));
check('jump misses roll back without exceeding the JS window cap',
  /MAX_LOADED - messagesRef\.current\.length/.test(chat) &&
  /messagesRef\.current = startingWindow;/.test(chat));
check('a distant indexed jump replaces rather than adjoins its local segment',
  /source = overlapsLoadedTail[\s\S]*?messagesRef\.current\.filter\(m => m\._tempId\)[\s\S]*?replacedWithSegment = true/.test(chat));
check('segmented history pages in both directions with an explicit gap boundary',
  /getCachedMessagesAfter\(cid, Number\(newest\), SCROLL_PAGE_SIZE\)/.test(chat) &&
  /newerGapBeforeId === item\.id/.test(chat));
check('settled JS history is capped while paging older and newer',
  (chat.match(/MAX_LOADED/g) ?? []).length >= 6 &&
  /slice\(-MAX_LOADED\)/.test(chat) && /slice\(0, MAX_LOADED\)/.test(chat));
check('trimming the older side keeps backward paging available',
  /if \(willTrimOlder\) setHasMore\(true\);/.test(chat));
check('return to latest rebuilds from the newest local hundred',
  /const returnToLatest[\s\S]*?INITIAL_PAGE_SIZE \+ PREFETCH_PAGE_SIZE[\s\S]*?setHasNewer\(false\)/.test(chat));
check('plaintext reply previews bypass async decryption',
  /if \(!looksEncrypted\(replyTarget\.content\)\)[\s\S]*?setReplyPlain\(replyTarget\.content \?\? ''\);[\s\S]*?return;/.test(bubble));
check('encrypted search backfills all local history in resumable pages',
  /const FTS_BACKFILL_PAGE = 400;/.test(localDb) &&
  /fts_meta \(k, v\) VALUES \('backfill_before', \?\)/.test(localDb) &&
  !/FTS_BACKFILL_CAP/.test(localDb));
check('in-chat search has no newest-1000 cap or Double Ratchet replay',
  /searchCachedMessagesInChat\(chatId, term, limit\)/.test(chatService) &&
  /getCachedChat\(chatId\)/.test(chatService) &&
  !/getCachedMessages\(chatId, 1000\)/.test(chatService) &&
  !/decryptFromChat\(chatId, m\.senderId, m\.content/.test(chatService));
check('search lifecycle invalidates restored rows and wipes its per-install key',
  /export async function importAll[\s\S]*?_ftsGeneration\+\+;[\s\S]*?DELETE FROM msg_fts[\s\S]*?DELETE FROM fts_meta/.test(localDb) &&
  /export async function clearLocalDb[\s\S]*?SecureStore\.deleteItemAsync\(FTS_KEY_STORE\)/.test(localDb));
check('a locked at-rest cache cannot be indexed or marked complete',
  /if \(opened\?\.startsWith\('enc:v1:'\)\) throw new Error\('message cache is locked'\)/.test(localDb));

console.log(failures ? `\n  ${failures} FAILED\n` : '\n  all chat-timeline checks passed\n');
process.exit(failures ? 1 : 0);
