// components/games/HistorySheet.tsx — the games you have already played.
//
// Two audiences in one sheet. A chess player wants the MOVES back — that is the
// game, and it is why chess entries expand into the full list. Everyone else
// wants "did I win, against whom, when", which is one line and stays one line:
// nobody replays a ludo dice sequence.
//
// Everything shown is what the SERVER said when the game ended. Nothing here
// recomputes a result, and a record whose fields the server never sent reads as
// "Finished" rather than as a guess (lib/games/history.ts).
//
// It is per device, and the sheet says so, because a history that silently
// disagrees with the other phone in your pocket is worse than one that explains
// itself. The games server keeps no results we can read.

import React, { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, Text, View } from 'react-native';
import { Sheet } from './feedback';
import { Btn, useType } from './ui';
import { C, S, R, mix, goldLine } from '../../lib/games/theme';
import { readHistory, clearHistory, whenLabel, MOVES_KEPT, type GameRecord } from '../../lib/games/history';
import { gameName } from '../../lib/games/inviteLink';

const TONE: Record<string, string> = { won: C.win, lost: C.lose, draw: C.gold, ended: C.muted };

/** Moves as numbered pairs, the way a scoresheet reads. */
function pairs(moves: string[]): { n: number; w: string; b: string }[] {
  const out: { n: number; w: string; b: string }[] = [];
  for (let i = 0; i < moves.length; i += 2) {
    out.push({ n: i / 2 + 1, w: moves[i] ?? '', b: moves[i + 1] ?? '' });
  }
  return out;
}

function Row({ rec }: { rec: GameRecord }) {
  const t = useType();
  const [open, setOpen] = useState(false);
  const canOpen = !!rec.moves?.length;

  return (
    <View style={{
      borderRadius: R[2], borderWidth: 1, borderColor: goldLine[14],
      backgroundColor: mix(C.panel2, 88, '#ffffff'), padding: S[3], gap: 4,
    }}>
      <Pressable
        onPress={() => canOpen && setOpen(o => !o)}
        accessibilityRole={canOpen ? 'button' : undefined}
        accessibilityLabel={`${gameName(rec.game)}, ${rec.detail}, ${whenLabel(rec.at)}${canOpen ? ', tap for the moves' : ''}`}
        style={{ flexDirection: 'row', alignItems: 'center', gap: S[2] }}
      >
        <View style={{ flex: 1 }}>
          <Text style={{ color: C.text, fontSize: t.sm, fontWeight: '800' }}>
            {gameName(rec.game)}
            {rec.opponents.length > 0 && (
              <Text style={{ color: C.muted, fontWeight: '600' }}>{`  vs ${rec.opponents.join(', ')}`}</Text>
            )}
          </Text>
          <Text style={{ color: C.muted, fontSize: 11.5, marginTop: 1 }}>
            {rec.detail}{rec.room ? ` · ${rec.room}` : ''}
          </Text>
        </View>
        <View style={{ alignItems: 'flex-end' }}>
          <Text style={{ color: TONE[rec.outcome] ?? C.muted, fontSize: t.sm, fontWeight: '800' }}>
            {rec.outcome === 'ended' ? '—' : rec.outcome}
          </Text>
          <Text style={{ color: C.muted, fontSize: 10.5 }}>{whenLabel(rec.at)}</Text>
        </View>
        {canOpen && <Text style={{ color: C.gold, fontSize: 14 }}>{open ? '▾' : '▸'}</Text>}
      </Pressable>

      {open && rec.moves && (
        <View style={{ gap: 2, marginTop: S[2], borderTopWidth: 1, borderTopColor: goldLine[14], paddingTop: S[2] }}>
          {pairs(rec.moves).map(p => (
            <Text key={p.n} selectable style={{ color: C.muted, fontSize: 12, fontFamily: 'monospace' }}>
              {`${String(p.n).padStart(2, ' ')}. ${p.w.padEnd(8, ' ')}${p.b}`}
            </Text>
          ))}
        </View>
      )}
    </View>
  );
}

export default function HistorySheet({ visible, onClose }: { visible: boolean; onClose: () => void }) {
  const t = useType();
  const [rows, setRows] = useState<GameRecord[] | null>(null);

  const load = useCallback(() => {
    setRows(null);
    readHistory().then(setRows).catch(() => setRows([]));
  }, []);

  useEffect(() => { if (visible) load(); }, [visible, load]);

  return (
    <Sheet visible={visible} title="Recent games" onClose={onClose}>
      {rows === null ? (
        <View style={{ paddingVertical: S[4], alignItems: 'center' }}><ActivityIndicator color={C.text} /></View>
      ) : rows.length === 0 ? (
        <Text style={{ color: C.muted, fontSize: t.sm, lineHeight: 19 }}>
          No games yet. Finish one and it appears here.
        </Text>
      ) : (
        // Sheet already scrolls its children in one ScrollView and already
        // supplies its own Close button below them — nesting a second
        // ScrollView here fought that one for the drag gesture, and a second
        // "Close" sat right under the real one.
        <View style={{ gap: S[2] }}>
          {rows.map(r => <Row key={`${r.game}:${r.room}:${r.at}`} rec={r} />)}
        </View>
      )}

      <Text style={{ color: C.muted, fontSize: 11.5, lineHeight: 17 }}>
        {`Kept on this phone — the games server does not store results we can read. Chess keeps every move of its last ${MOVES_KEPT} games; tap one to see them.`}
      </Text>
      {rows && rows.length > 0 && (
        <Btn
          label="Clear"
          kind="danger"
          compact
          onPress={() => { void clearHistory().then(load); }}
        />
      )}
    </Sheet>
  );
}
