# Figma screens — ready to run

The design system is built in Figma. The five screens are not, because the
account hit its **Starter-plan limit of 20 MCP tool calls per month** (View seat;
`whoami` and `create_new_file` are exempt, everything else counts). The quota
renews monthly.

Nothing here needs re-deriving when it does — the scripts below are written
against the real node IDs and property keys returned when the components were
created. Run them in order, one `use_figma` call each, against
`fileKey = zomjMMcjw8sTXPpJh84lKi`. Six calls total.

## What already exists in the file

| | id | notes |
|---|---|---|
| Page: Foundations | `0:1` | cover, swatches, type specimen, scale bars |
| Page: Components | `2:4` | the five component sets |
| Page: Screens | `2:5` | **empty — this is what remains** |
| Playing Card (set) | `4:25` | `State=` Default / Selected / Wild / Disabled / Back · props `Rank#4:0`, `Suit#4:6` |
| Status Pill (set) | `4:42` | `Tone=` Turn / Waiting / Warning / Error / Neutral · prop `Label#4:12` |
| Button (set) | `4:53` | `Kind=` Primary / Neutral / Good / Danger / Disabled · prop `Label#4:18` |
| Seat (set) | `5:26` | `State=` Idle / Active / Bot / Empty · prop `Name#5:0` |
| Game Card (set) | `7:14` | `Kind=` Featured / Tile / Continue · props `Title#7:0`, `Presence#7:4` |

Variables: 55 across `Primitives` and `Games`. Text styles: `Games/Display`,
`Title`, `Heading`, `Body`, `Label`, `Caption`, `Seat name`, `Numeric`.
Effect styles: `Games/Card lift`, `Games/Raised`.

## Rules these scripts already account for

Learned the hard way while building the components — each of these produced a
real bug:

- **`layoutMode` BEFORE `resize()`.** Assigning `layoutMode` resets sizing to
  hug, so a resize before it is discarded. That is what rendered the seat
  avatars as narrow ovals instead of 28px circles.
- **`appendChild` before `layoutSizingHorizontal = 'FILL'`.** FILL is only valid
  on a child of an auto-layout parent.
- **Component properties live on the SET, so every variant inherits them** — and
  the property default overrides whatever characters a variant was built with.
  That printed a rank on the back of a face-down card.
- **Instance subtrees are immutable.** A screen cannot append a Button into a
  Game Card instance; the card must own it. Script 0 exists for exactly this.
- **Load every font before writing text**, and return every created node ID.

---

## Script 0 — give Game Card its own action button

Must run first: scripts 1 and 2 place Game Card instances that are expected to
carry a button, and an instance cannot be given one afterwards.

```js
const page = figma.root.children.find(p => p.name === 'Components');
await figma.setCurrentPageAsync(page);
await Promise.all([
  figma.loadFontAsync({ family: 'Roboto', style: 'Bold' }),
  figma.loadFontAsync({ family: 'Roboto', style: 'Black' }),
  figma.loadFontAsync({ family: 'Roboto', style: 'Regular' }),
]);
const cardSet = await figma.getNodeByIdAsync('7:14');
const btnSet = await figma.getNodeByIdAsync('4:53');

const added = [];
for (const [variantName, kind, label] of [
  ['Kind=Featured', 'Kind=Neutral', 'Quick match'],
  ['Kind=Continue', 'Kind=Primary', 'Resume'],
]) {
  const v = cardSet.children.find(c => c.name === variantName);
  if (!v || v.findOne(n => n.type === 'INSTANCE')) continue; // idempotent
  const inst = btnSet.children.find(c => c.name === kind).createInstance();
  inst.name = 'Action';
  v.appendChild(inst);
  inst.layoutSizingHorizontal = 'FILL';
  const key = Object.keys(inst.componentProperties || {}).find(k => k.startsWith('Label'));
  if (key) inst.setProperties({ [key]: label });
  added.push({ variant: variantName, id: inst.id, label });
}
return { mutatedNodeIds: [cardSet.id], added };
```

---

## Shared preamble

Scripts 1–5 all open with this. It resolves the page, tokens, styles and the
paint helper.

```js
const page = figma.root.children.find(p => p.name === 'Screens');
await figma.setCurrentPageAsync(page);
const V = Object.fromEntries((await figma.variables.getLocalVariablesAsync()).map(v => [v.name, v]));
const TS = Object.fromEntries((await figma.getLocalTextStylesAsync()).map(s => [s.name, s]));
const paint = (n) => figma.variables.setBoundVariableForPaint(
  { type: 'SOLID', color: { r: 0, g: 0, b: 0 } }, 'color', V[n]);
await Promise.all([
  figma.loadFontAsync({ family: 'Roboto', style: 'Black' }),
  figma.loadFontAsync({ family: 'Roboto', style: 'Bold' }),
  figma.loadFontAsync({ family: 'Roboto', style: 'Regular' }),
  figma.loadFontAsync({ family: 'Roboto Mono', style: 'Medium' }),
]);
const txt = (name, chars, style, colour) => {
  const t = figma.createText();
  t.name = name; t.characters = chars;
  t.textStyleId = TS[style].id; t.fills = [paint(colour)];
  return t;
};
const grow = (parent) => { const s = figma.createFrame(); s.fills = []; s.resize(8, 1); parent.appendChild(s); s.layoutGrow = 1; return s; };
const screenFrame = (name, w, h, x) => {
  const f = figma.createAutoLayout('VERTICAL', { name, itemSpacing: 14 });
  f.resize(w, h);
  f.layoutSizingHorizontal = 'FIXED'; f.layoutSizingVertical = 'FIXED';
  f.fills = [paint('color/bg')]; f.clipsContent = true;
  f.setBoundVariable('paddingLeft', V['space/4']);
  f.setBoundVariable('paddingRight', V['space/4']);
  f.setBoundVariable('paddingTop', V['space/5']);
  f.setBoundVariable('paddingBottom', V['space/4']);
  f.x = x; f.y = 0;
  return f;
};
```

Device sizes: portrait screens are **411 × 915** (standard Android phone in dp).
The rummy table is **915 × 411** — landscape, because `Rummy.tsx` locks that
orientation while playing.

---

## Script 1 — Games Home  (x = 0)

Continue is the hero and holds the only gold on the screen; featured is a step
down; three tiles are subordinate; destinations are a hairline list, not three
more buttons.

```js
/* shared preamble */
const cardSet = await figma.getNodeByIdAsync('7:14');
const kind = (n) => cardSet.children.find(c => c.name === n);

const s = screenFrame('Games Home', 411, 915, 0);

const bar = figma.createAutoLayout('HORIZONTAL', { name: 'Top bar', itemSpacing: 12 });
bar.fills = []; bar.counterAxisAlignItems = 'CENTER';
bar.appendChild(txt('Wordmark', 'Games', 'Games/Title', 'color/text'));
grow(bar);
bar.appendChild(txt('Coins', '2,050', 'Games/Numeric', 'color/accent'));
s.appendChild(bar); bar.layoutSizingHorizontal = 'FILL';

const cont = kind('Kind=Continue').createInstance();
cont.setProperties({ 'Title#7:0': 'Rummy', 'Presence#7:4': 'Your turn - 0:42' });
s.appendChild(cont); cont.layoutSizingHorizontal = 'FILL';

s.appendChild(txt('S1', 'FEATURED', 'Games/Caption', 'color/text-muted'));
const feat = kind('Kind=Featured').createInstance();
feat.setProperties({ 'Title#7:0': 'Chess', 'Presence#7:4': 'Nobody waiting' });
s.appendChild(feat); feat.layoutSizingHorizontal = 'FILL';

const rail = figma.createAutoLayout('HORIZONTAL', { name: 'Rail', itemSpacing: 10 });
rail.fills = [];
for (const [t, p] of [['Rummy', '3 of 6 seated'], ['Ludo', 'Nobody waiting'], ['Tic-Tac-Toe', 'Nobody waiting']]) {
  const tile = kind('Kind=Tile').createInstance();
  tile.setProperties({ 'Title#7:0': t, 'Presence#7:4': p });
  rail.appendChild(tile); tile.layoutSizingHorizontal = 'FILL';
}
s.appendChild(rail); rail.layoutSizingHorizontal = 'FILL';

const list = figma.createAutoLayout('VERTICAL', { name: 'Destinations', itemSpacing: 0 });
list.fills = [];
for (const label of ['Leaderboard', 'Recent games', 'Join with a room code']) {
  const row = figma.createAutoLayout('HORIZONTAL', { name: label, itemSpacing: 12 });
  row.fills = []; row.counterAxisAlignItems = 'CENTER';
  row.setBoundVariable('paddingTop', V['space/3']);
  row.setBoundVariable('paddingBottom', V['space/3']);
  row.strokes = [paint('color/line')];
  row.strokeTopWeight = 1; row.strokeBottomWeight = 0;
  row.strokeLeftWeight = 0; row.strokeRightWeight = 0;
  row.appendChild(txt('Label', label, 'Games/Body', 'color/text'));
  grow(row);
  row.appendChild(txt('Chev', '>', 'Games/Body', 'color/text-muted'));
  list.appendChild(row); row.layoutSizingHorizontal = 'FILL';
}
s.appendChild(list); list.layoutSizingHorizontal = 'FILL'; list.layoutGrow = 1;

await s.screenshot();
return { createdNodeIds: [s.id] };
```

---

## Script 2 — Mode Sheet  (x = 460)

The three existing modes, wording verbatim. The bot is always named a bot.

```js
/* shared preamble */
const btnSet = await figma.getNodeByIdAsync('4:53');
const s = screenFrame('Mode Sheet', 411, 915, 460);
s.primaryAxisAlignItems = 'MAX';   // sheet sits at the bottom

const sheet = figma.createAutoLayout('VERTICAL', { name: 'Sheet', itemSpacing: 10 });
sheet.fills = [paint('color/bg-raised')];
sheet.strokes = [paint('color/line')]; sheet.strokeWeight = 1;
for (const k of ['topLeftRadius', 'topRightRadius']) sheet.setBoundVariable(k, V['radius/4']);
for (const k of ['paddingLeft', 'paddingRight', 'paddingTop', 'paddingBottom']) sheet.setBoundVariable(k, V['space/4']);

const head = figma.createAutoLayout('VERTICAL', { name: 'Head', itemSpacing: 2 });
head.fills = [];
head.appendChild(txt('Game', 'Rummy', 'Games/Title', 'color/text'));
head.appendChild(txt('Sub', 'Points rummy - 2-6 players - free table', 'Games/Caption', 'color/text-muted'));
sheet.appendChild(head); head.layoutSizingHorizontal = 'FILL';

const MODES = [
  ['Play online', 'Find someone who is looking for a game right now'],
  ['Private room', 'Your own table with a code to share - and voice chat at it'],
  ['Play the house bot', 'Start straight away, against the table'],
];
for (const [title, hint] of MODES) {
  const row = figma.createAutoLayout('HORIZONTAL', { name: title, itemSpacing: 12 });
  row.fills = [paint('color/surface')];
  row.strokes = [paint('color/line')]; row.strokeWeight = 1;
  row.counterAxisAlignItems = 'CENTER';
  for (const k of ['topLeftRadius', 'topRightRadius', 'bottomLeftRadius', 'bottomRightRadius']) row.setBoundVariable(k, V['radius/3']);
  for (const k of ['paddingLeft', 'paddingRight', 'paddingTop', 'paddingBottom']) row.setBoundVariable(k, V['space/3']);
  const col = figma.createAutoLayout('VERTICAL', { name: 'Text', itemSpacing: 2 });
  col.fills = [];
  col.appendChild(txt('Title', title, 'Games/Label', 'color/text'));
  const h = txt('Hint', hint, 'Games/Caption', 'color/text-muted');
  col.appendChild(h);
  row.appendChild(col); col.layoutSizingHorizontal = 'FILL';
  h.layoutSizingHorizontal = 'FILL'; h.textAutoResize = 'HEIGHT';
  row.appendChild(txt('Chev', '>', 'Games/Body', 'color/text-muted'));
  sheet.appendChild(row); row.layoutSizingHorizontal = 'FILL';
}
const foot = txt('Foot', 'A bot is always labelled a bot. Coins are play coins - not money.', 'Games/Caption', 'color/text-muted');
sheet.appendChild(foot); foot.layoutSizingHorizontal = 'FILL'; foot.textAutoResize = 'HEIGHT';

s.appendChild(sheet); sheet.layoutSizingHorizontal = 'FILL';
await s.screenshot();
return { createdNodeIds: [s.id] };
```

---

## Script 3 — Rummy Table  (x = 920, LANDSCAPE 915 × 411)

Four bands that never collide: header, felt, hand, actions. The active seat
carries a ring, a heavier stroke and an inline clock — never colour alone.

```js
/* shared preamble */
const cardCmp = await figma.getNodeByIdAsync('4:25');
const seatCmp = await figma.getNodeByIdAsync('5:26');
const pillCmp = await figma.getNodeByIdAsync('4:42');
const btnCmp  = await figma.getNodeByIdAsync('4:53');
const pick = (set, n) => set.children.find(c => c.name === n);

const s = screenFrame('Rummy Table', 915, 411, 920);
s.itemSpacing = 8;

const head = figma.createAutoLayout('HORIZONTAL', { name: 'Header', itemSpacing: 10 });
head.fills = []; head.counterAxisAlignItems = 'CENTER';
const hcol = figma.createAutoLayout('VERTICAL', { name: 'Table', itemSpacing: 0 });
hcol.fills = [];
hcol.appendChild(txt('Name', 'Practice', 'Games/Label', 'color/text'));
hcol.appendChild(txt('Terms', 'Free - 3 seated', 'Games/Caption', 'color/text-muted'));
head.appendChild(hcol); grow(head);
head.appendChild(txt('Clock', '0:38', 'Games/Numeric', 'color/text'));
s.appendChild(head); head.layoutSizingHorizontal = 'FILL';

// felt
const felt = figma.createFrame();
felt.name = 'Felt';
felt.layoutMode = 'VERTICAL';            // layoutMode BEFORE resize
felt.primaryAxisAlignItems = 'CENTER';
felt.counterAxisAlignItems = 'CENTER';
felt.resize(883, 190);
felt.fills = [{ type: 'GRADIENT_RADIAL', gradientTransform: [[1,0,0],[0,1,0]], gradientStops: [
  { position: 0,   color: { r: 0.118, g: 0.373, b: 0.455, a: 1 } },
  { position: 0.55,color: { r: 0.071, g: 0.239, b: 0.306, a: 1 } },
  { position: 1,   color: { r: 0.043, g: 0.153, b: 0.200, a: 1 } },
]}];
felt.strokes = [paint('color/accent-deep')]; felt.strokeWeight = 2;
for (const k of ['topLeftRadius','topRightRadius','bottomLeftRadius','bottomRightRadius']) felt.setBoundVariable(k, V['radius/4']);
felt.itemSpacing = 8;

const piles = figma.createAutoLayout('HORIZONTAL', { name: 'Piles', itemSpacing: 10 });
piles.fills = [];
const closed = pick(cardCmp, 'State=Back').createInstance();
const open   = pick(cardCmp, 'State=Default').createInstance();
open.setProperties({ 'Rank#4:0': '9', 'Suit#4:6': '♥' });
const wild   = pick(cardCmp, 'State=Wild').createInstance();
wild.setProperties({ 'Rank#4:0': '3', 'Suit#4:6': '♠' });
for (const p of [closed, open, wild]) piles.appendChild(p);
felt.appendChild(piles);
felt.appendChild(txt('Labels', 'closed    open    wild', 'Games/Caption', 'color/text-muted'));
s.appendChild(felt); felt.layoutSizingHorizontal = 'FILL'; felt.layoutGrow = 1;

// seats sit over the felt in the real screen; here they read as a row
const seats = figma.createAutoLayout('HORIZONTAL', { name: 'Seats', itemSpacing: 10 });
seats.fills = [];
const s1 = pick(seatCmp, 'State=Bot').createInstance();
const s2 = pick(seatCmp, 'State=Idle').createInstance();
s2.setProperties({ 'Name#5:0': 'Testing' });
const s3 = pick(seatCmp, 'State=Active').createInstance();
s3.setProperties({ 'Name#5:0': 'Srihari B' });
for (const n of [s1, s2, s3]) seats.appendChild(n);
s.appendChild(seats); seats.layoutSizingHorizontal = 'FILL';

const pill = pick(pillCmp, 'Tone=Turn').createInstance();
pill.setProperties({ 'Label#4:12': 'Your turn - take a card' });
s.appendChild(pill);

// hand: four groups, the last holding the joker
const hand = figma.createAutoLayout('HORIZONTAL', { name: 'Hand', itemSpacing: 10 });
hand.fills = []; hand.primaryAxisAlignItems = 'CENTER';
const GROUPS = [
  [['8','♠'], ['8','♥'], ['8','♦']],
  [['A','♠'], ['10','♠']],
  [['6','♥'], ['J','♥'], ['K','♥']],
];
for (const g of GROUPS) {
  const tray = figma.createAutoLayout('HORIZONTAL', { name: 'Group', itemSpacing: 0 });
  tray.fills = []; tray.strokes = [paint('color/line')]; tray.strokeWeight = 1;
  tray.dashPattern = [4, 4];
  for (const k of ['topLeftRadius','topRightRadius','bottomLeftRadius','bottomRightRadius']) tray.setBoundVariable(k, V['radius/2']);
  for (const k of ['paddingLeft','paddingRight','paddingTop','paddingBottom']) tray.setBoundVariable(k, V['space/1']);
  for (const [r, su] of g) {
    const c = pick(cardCmp, 'State=Default').createInstance();
    c.setProperties({ 'Rank#4:0': r, 'Suit#4:6': su });
    tray.appendChild(c);
  }
  hand.appendChild(tray);
}
const jokerTray = figma.createAutoLayout('HORIZONTAL', { name: 'Joker', itemSpacing: 0 });
jokerTray.fills = [];
const jk = pick(cardCmp, 'State=Wild').createInstance();
jk.setProperties({ 'Rank#4:0': '3', 'Suit#4:6': '♠' });
jokerTray.appendChild(jk);
hand.appendChild(jokerTray);
s.appendChild(hand); hand.layoutSizingHorizontal = 'FILL';

// six actions, 3x2, one gold
const acts = figma.createAutoLayout('HORIZONTAL', { name: 'Actions', itemSpacing: 6 });
acts.fills = [];
for (const [k, label] of [['Kind=Primary','Sort'], ['Kind=Neutral','Group'], ['Kind=Disabled','Ungroup'],
                          ['Kind=Neutral','Discard'], ['Kind=Good','Declare'], ['Kind=Danger','Drop']]) {
  const b = pick(btnCmp, k).createInstance();
  b.setProperties({ 'Label#4:18': label });
  acts.appendChild(b); b.layoutSizingHorizontal = 'FILL';
}
s.appendChild(acts); acts.layoutSizingHorizontal = 'FILL';

await s.screenshot();
return { createdNodeIds: [s.id] };
```

---

## Script 4 — Chess  (x = 1380)

The board dominates; legal moves are dots the table sent, not something the
client worked out.

```js
/* shared preamble */
const seatCmp = await figma.getNodeByIdAsync('5:26');
const btnCmp  = await figma.getNodeByIdAsync('4:53');
const pick = (set, n) => set.children.find(c => c.name === n);
const s = screenFrame('Chess', 411, 915, 1380);

s.appendChild(txt('T', 'Chess', 'Games/Title', 'color/text'));
const top = pick(seatCmp, 'State=Idle').createInstance();
top.setProperties({ 'Name#5:0': 'Testing' });
s.appendChild(top);

const board = figma.createFrame();
board.name = 'Board';
board.layoutMode = 'NONE';
board.resize(379, 379);
board.clipsContent = true;
for (const k of ['topLeftRadius','topRightRadius','bottomLeftRadius','bottomRightRadius']) board.setBoundVariable(k, V['radius/2']);
const LIGHT = { r: 0.937, g: 0.890, b: 0.808 }, DARK = { r: 0.431, g: 0.227, b: 0.196 };
const cell = 379 / 8;
const PIECES = ['♜♞♝♛♚♝♞♜','♟♟♟♟♟♟♟♟','','','','','♙♙♙♙♙♙♙♙','♖♘♗♕♔♗♘♖'];
for (let r = 0; r < 8; r++) for (let c = 0; c < 8; c++) {
  const sq = figma.createRectangle();
  sq.resize(cell, cell); sq.x = c * cell; sq.y = r * cell;
  sq.fills = [{ type: 'SOLID', color: (r + c) % 2 ? DARK : LIGHT }];
  board.appendChild(sq);
  const row = PIECES[r];
  if (row && row[c]) {
    const g = figma.createText();
    g.characters = row[c];
    g.fontName = { family: 'Roboto', style: 'Regular' };
    g.fontSize = cell * 0.72;
    g.fills = [{ type: 'SOLID', color: r < 2 ? { r: 0.106, g: 0.071, b: 0.063 } : { r: 1, g: 0.976, b: 0.945 } }];
    g.textAlignHorizontal = 'CENTER';
    g.resize(cell, cell);
    g.x = c * cell; g.y = r * cell + cell * 0.08;
    board.appendChild(g);
  }
}
// two legal-move dots for the e2 pawn
for (const [r, c] of [[4, 4], [5, 4]]) {
  const dot = figma.createEllipse();
  dot.resize(cell * 0.22, cell * 0.22);
  dot.x = c * cell + cell * 0.39; dot.y = r * cell + cell * 0.39;
  dot.fills = [{ type: 'SOLID', color: { r: 0.118, g: 0.071, b: 0.063 }, opacity: 0.32 }];
  board.appendChild(dot);
}
s.appendChild(board);

const me = pick(seatCmp, 'State=Active').createInstance();
me.setProperties({ 'Name#5:0': 'Srihari B' });
s.appendChild(me);

const row = figma.createAutoLayout('HORIZONTAL', { name: 'Actions', itemSpacing: 8 });
row.fills = [];
for (const [k, l] of [['Kind=Neutral','Invite'], ['Kind=Neutral','Add a bot']]) {
  const b = pick(btnCmp, k).createInstance();
  b.setProperties({ 'Label#4:18': l });
  row.appendChild(b); b.layoutSizingHorizontal = 'FILL';
}
s.appendChild(row); row.layoutSizingHorizontal = 'FILL';

await s.screenshot();
return { createdNodeIds: [s.id] };
```

---

## Script 5 — Result  (x = 1840)

Outcome largest, in the server's own words. Your row is marked. A zero coin
delta stays a plain `0` — the line beneath says what actually happened, so
nothing is ever reported as "+0 coins".

```js
/* shared preamble */
const btnCmp = await figma.getNodeByIdAsync('4:53');
const pick = (set, n) => set.children.find(c => c.name === n);
const s = screenFrame('Result', 411, 915, 1840);

const head = figma.createAutoLayout('VERTICAL', { name: 'Outcome', itemSpacing: 6 });
head.fills = []; head.counterAxisAlignItems = 'CENTER';
head.setBoundVariable('paddingTop', V['space/6']);
head.appendChild(txt('Kick', 'THIS DEAL', 'Games/Caption', 'color/text-muted'));
head.appendChild(txt('Out', 'Robo 1 won', 'Games/Display', 'color/text'));
head.appendChild(txt('Sub', '1 of 2 players were still in the hand', 'Games/Caption', 'color/text-muted'));
s.appendChild(head); head.layoutSizingHorizontal = 'FILL';

const table = figma.createAutoLayout('VERTICAL', { name: 'Scoreboard', itemSpacing: 0 });
table.fills = [paint('color/surface')];
table.strokes = [paint('color/line')]; table.strokeWeight = 1;
for (const k of ['topLeftRadius','topRightRadius','bottomLeftRadius','bottomRightRadius']) table.setBoundVariable(k, V['radius/3']);

const mkRow = (rank, name, pts, coins, mine) => {
  const r = figma.createAutoLayout('HORIZONTAL', { name: name, itemSpacing: 10 });
  r.fills = mine ? [paint('color/bg-raised')] : [];
  r.counterAxisAlignItems = 'CENTER';
  for (const k of ['paddingLeft','paddingRight','paddingTop','paddingBottom']) r.setBoundVariable(k, V['space/3']);
  if (mine) { r.strokes = [paint('color/accent')]; r.strokeLeftWeight = 3;
              r.strokeTopWeight = 0; r.strokeRightWeight = 0; r.strokeBottomWeight = 0; }
  r.appendChild(txt('#', String(rank), 'Games/Label', mine ? 'color/accent' : 'color/text-muted'));
  r.appendChild(txt('Name', name, 'Games/Body', 'color/text'));
  grow(r);
  r.appendChild(txt('Pts', pts, 'Games/Numeric', 'color/text'));
  r.appendChild(txt('Coins', coins, 'Games/Numeric', coins.startsWith('+') ? 'color/win' : 'color/text-muted'));
  return r;
};
const h = mkRow('#', 'Player', 'Pts', 'Coins', false);
table.appendChild(h); h.layoutSizingHorizontal = 'FILL';
for (const [rank, name, pts, coins, mine] of [[1, 'Robo 1', '0', '+40', false], [2, 'You', '20', '0', true]]) {
  const r = mkRow(rank, name, pts, coins, mine);
  table.appendChild(r); r.layoutSizingHorizontal = 'FILL';
}
s.appendChild(table); table.layoutSizingHorizontal = 'FILL';

const note = txt('Note', 'You dropped before your first turn', 'Games/Caption', 'color/text-muted');
s.appendChild(note); note.layoutSizingHorizontal = 'FILL';

const spacer = figma.createFrame(); spacer.fills = []; spacer.resize(1, 8);
s.appendChild(spacer); spacer.layoutGrow = 1;

const primary = pick(btnCmp, 'Kind=Primary').createInstance();
primary.setProperties({ 'Label#4:18': 'Deal again' });
s.appendChild(primary); primary.layoutSizingHorizontal = 'FILL';

const pair = figma.createAutoLayout('HORIZONTAL', { name: 'Secondary', itemSpacing: 8 });
pair.fills = [];
for (const l of ['Share', 'Back to tables']) {
  const b = pick(btnCmp, 'Kind=Neutral').createInstance();
  b.setProperties({ 'Label#4:18': l });
  pair.appendChild(b); b.layoutSizingHorizontal = 'FILL';
}
s.appendChild(pair); pair.layoutSizingHorizontal = 'FILL';

await s.screenshot();
return { createdNodeIds: [s.id] };
```

---

## After running

Validate each with `get_screenshot` on the returned node id. The failure modes
to look for, in order of how often they actually happened while building the
components:

1. placeholder text still showing (`Title`, `Heading`, `Button`) — a
   `setProperties` key was wrong; read the real key off `componentProperties`
2. clipped text — a wrapping TEXT needs `textAutoResize = 'HEIGHT'` plus an
   explicit width, not `FILL` alone
3. a child that hugs when it should fill — `layoutSizingHorizontal` was set
   before `appendChild`
4. wrong variant — check the source component's DEFAULT prop, not just what the
   call site passes
