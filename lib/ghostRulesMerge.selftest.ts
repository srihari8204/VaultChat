// lib/ghostRulesMerge.selftest.ts — run: npx tsx lib/ghostRulesMerge.selftest.ts
import assert from 'node:assert/strict';
import { mergeReloadedRules, type GhostRuleLike } from './ghostRulesMerge';

const rule = (targetId: string, o: Partial<GhostRuleLike> = {}): GhostRuleLike => ({
  targetId, hideOnline: false, hideTyping: false, hideRead: false, hideLastSeen: false, ...o,
});

// Nothing in flight: the server's answer replaces the screen's.
assert.deepEqual(
  mergeReloadedRules({ a: rule('a', { hideRead: true }) }, { a: rule('a'), b: rule('b', { hideTyping: true }) }, []),
  { a: rule('a', { hideRead: true }) },
);

// One flag in flight: only that flag keeps the screen's value; the same
// contact's other flags and every other contact take the reload.
{
  const fetched = { a: rule('a', { hideTyping: true }), b: rule('b', { hideLastSeen: true }) };
  const current = { a: rule('a', { hideRead: true }), b: rule('b') };
  const out = mergeReloadedRules(fetched, current, [{ userId: 'a', flag: 'hideRead' }]);
  assert.equal(out.a.hideRead, true, 'the tapped flag is not undone');
  assert.equal(out.a.hideTyping, true, 'the same contact\'s other flag reloads');
  assert.equal(out.b.hideLastSeen, true, 'another contact reloads (it used to be discarded)');
}

// A first rule for a contact the server does not know yet is kept.
{
  const out = mergeReloadedRules({}, { c: rule('c', { hideLastSeen: true }) }, [{ userId: 'c', flag: 'hideLastSeen' }]);
  assert.deepEqual(out.c, rule('c', { hideLastSeen: true }));
}

// Inputs are not mutated.
{
  const fetched = { a: rule('a') };
  mergeReloadedRules(fetched, { a: rule('a', { hideRead: true }) }, [{ userId: 'a', flag: 'hideRead' }]);
  assert.equal(fetched.a.hideRead, false);
}

console.log('ghostRulesMerge selftest: all passed');
