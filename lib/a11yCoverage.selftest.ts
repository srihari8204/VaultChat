// lib/a11yCoverage.selftest.ts — run: npx tsx lib/a11yCoverage.selftest.ts
//
// AUDIT F11. Screen-reader coverage was partial rather than absent — font
// scaling, a reduced-motion hook and labelled icon buttons in newer code were
// already in place — which makes finishing it a sweep rather than a project.
//
// THE ONE THING A SCANNER CAN CHECK HONESTLY is an ICON-ONLY BUTTON: a
// touchable whose entire visible content is an icon, with no text anywhere
// inside it. To a sighted user that is a back arrow or a send button; to a
// screen reader it is "button", with nothing else said. Every other
// accessibility question — is the label accurate, is the reading order sane,
// does the contrast hold — needs a person, and a test that pretended otherwise
// would give false comfort.
//
// So this guard is narrow and absolute: an icon-only touchable must carry an
// accessibilityLabel. It is ratcheted rather than absolute-from-day-one — the
// BUDGET below is the count of remaining unlabelled buttons, and it may only go
// down. That makes the sweep incremental without letting it slide backwards,
// which a pass/fail gate on 195 screens could not do.
//
// Opt out in place with `a11y-exempt:` and a reason on the same line, the same
// convention as the layout and theme guards.

import fs from 'node:fs';
import path from 'node:path';

// Lower this as screens are swept. It may never be raised: a rise means new
// unlabelled buttons shipped, which is the thing this exists to stop. The test
// also FAILS when the real count drops below the budget, so a sweep is not
// finished until the number here is lowered to match — which is what stops the
// ratchet quietly loosening.
//
// 13 September: 282 → 215. The ten screens people actually use every day were
// swept by hand — the five tabs, the chat screen, the media viewer and gallery,
// the story viewer, and encrypted notes — 67 buttons, each label written from
// the handler and the icon rather than generated. A wrong label is worse than
// none: a screen reader states it confidently and the user has no way to tell.
//
// 13 September, later the same day: 215 → 137. Fifteen more screens swept —
// shop book, the group tools (tasks, notes, calendar, admin, invites), the
// reader and shelf, the file viewer and slideshow, live view, the meeting
// scheduler, finance reminders, call recording and the nav map — 78 buttons,
// same rule: every label read off its own handler and icon, and where the
// button acts on a row the label names the row (“Delete the list Monthly
// groceries”, not “Delete”).
//
// 137 → 132 with no further labelling: that sweep found a hole in this very
// scanner. It only knew react-native's <Text>, so every button using the app's
// own AppText or ThemedText wrapper was reported as icon-only — eleven false
// positives that a sweep then spends real attention on. The hole was found by
// the first sweep to use the guard, which is the right way to find it and the
// wrong way to keep it.
//
// 125 → 107: the messenger's own navigation chrome. Eighteen buttons on the
// paths people take to reach a conversation — the back arrows and search
// clears on new chat, search, in-chat search, message requests, group info,
// bookmarks, hidden chats, create group, contacts, contact info and group
// calls, the shared ui/Header back arrow, the in-call chat's close and send,
// and the voice-message play/pause in the bubble, whose label states which it
// will do next.
const BUDGET = 107;

const ROOTS = ['app', 'components'];
const SKIP_DIR = /node_modules|\.expo|android|ios|dist|build/;

/** Every .tsx under the roots. */
function sources(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!SKIP_DIR.test(p)) sources(p, out);
    } else if (entry.name.endsWith('.tsx')) {
      out.push(p);
    }
  }
  return out;
}

const TOUCHABLE = /<(TouchableOpacity|Pressable|TouchableHighlight|TouchableWithoutFeedback)\b/g;

/**
 * Find the matching close tag for a JSX element starting at `open`.
 * Returns the element's full source, or null if it is self-closing or unclosed.
 */
function elementBody(src: string, open: number, tag: string): string | null {
  // Walk to the end of the opening tag, respecting quotes and braces so a
  // `>` inside a prop (an arrow function, a comparison) does not end it early.
  let i = open;
  let depthBrace = 0;
  let quote: string | null = null;
  for (; i < src.length; i++) {
    const c = src[i];
    if (quote) { if (c === quote) quote = null; continue; }
    if (c === '"' || c === "'" || c === '`') { quote = c; continue; }
    if (c === '{') depthBrace++;
    else if (c === '}') depthBrace--;
    else if (c === '>' && depthBrace === 0) break;
  }
  if (i >= src.length) return null;
  if (src[i - 1] === '/') return null;            // self-closing: no children

  const openTagEnd = i + 1;
  const openRe = new RegExp(`<${tag}\\b`, 'g');
  const closeRe = new RegExp(`</${tag}>`, 'g');
  let depth = 1;
  let cursor = openTagEnd;
  while (depth > 0) {
    openRe.lastIndex = cursor;
    closeRe.lastIndex = cursor;
    const nextOpen = openRe.exec(src);
    const nextClose = closeRe.exec(src);
    if (!nextClose) return null;
    if (nextOpen && nextOpen.index < nextClose.index) {
      depth++;
      cursor = nextOpen.index + tag.length;
    } else {
      depth--;
      cursor = nextClose.index + tag.length + 3;
    }
  }
  return src.slice(open, cursor);
}

interface Offender { file: string; line: number; snippet: string }

const offenders: Offender[] = [];
let touchables = 0;
let iconOnly = 0;

for (const root of ROOTS) {
  for (const file of sources(root)) {
    const src = fs.readFileSync(file, 'utf8');
    TOUCHABLE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = TOUCHABLE.exec(src))) {
      touchables++;
      const tag = m[1];
      const body = elementBody(src, m.index, tag);
      if (!body) continue;

      // Icon-only = contains an icon component and NO text at all: no <Text>,
      // no title/label prop, and no bare string child. Anything with text has
      // something for a screen reader to read, whether or not it is ideal.
      const hasIcon = /<(Ionicons|MaterialIcons|MaterialCommunityIcons|FontAwesome\w*|Feather|AntDesign|Entypo|Octicons|SimpleLineIcons)\b/.test(body);
      if (!hasIcon) continue;
      // Every component in this project that RENDERS TEXT, not just
      // react-native's <Text>. AppText (components/ui/Text.tsx) and ThemedText
      // (components/themed-text.tsx) are the app's own wrappers, and a scanner
      // that knew only the built-in one reported AppText buttons as
      // "icon-only" — false positives that a sweep then spends real attention
      // labelling. Found by the first sweep to use this guard, which is the
      // right way to find it and the wrong way to keep it.
      const hasText = /<(Text|AppText|ThemedText|Label|Heading|Title)\b/.test(body)
        || /\btitle=/.test(body) || /\blabel=/.test(body);
      if (hasText) continue;

      iconOnly++;
      if (/accessibilityLabel|a11y-exempt/.test(body)) continue;

      offenders.push({
        file: file.replace(/\\/g, '/'),
        line: src.slice(0, m.index).split('\n').length,
        snippet: body.slice(0, 70).replace(/\s+/g, ' '),
      });
    }
  }
}

console.log('\nAccessibility coverage self-test\n');
console.log(`  touchables scanned:        ${touchables}`);
console.log(`  icon-only (need a label):  ${iconOnly}`);
console.log(`  unlabelled:                ${offenders.length}  (budget ${BUDGET})\n`);

if (offenders.length > BUDGET) {
  console.log('  Icon-only buttons with no accessibilityLabel — to a screen reader');
  console.log('  these announce as "button" and nothing else:\n');
  for (const o of offenders.slice(0, 400)) {
    console.log(`    ${o.file}:${o.line}  ${o.snippet}`);
  }
  if (offenders.length > 400) console.log(`    … and ${offenders.length - 400} more`);
  console.log(`\n  Add accessibilityLabel, or opt out in place with a11y-exempt: <reason>.\n`);
  process.exit(1);
}

if (offenders.length < BUDGET) {
  console.log(`  ${BUDGET - offenders.length} fewer than the budget — lower BUDGET to ${offenders.length} so it cannot slide back.\n`);
  process.exit(1);
}

// Honest about what passing means. "Every icon-only button is labelled" would
// be a lie while the budget is above zero, and a guard that overstates its own
// coverage is worse than one that does not exist.
console.log(offenders.length === 0
  ? '  every icon-only button is labelled\n'
  : `  at the budget — ${offenders.length} still unlabelled, and the number cannot grow\n`);
