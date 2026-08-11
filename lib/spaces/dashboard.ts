// lib/spaces/dashboard.ts — the numbers on an operations dashboard
// (Spaces & Operations, S3.2).
//
// EVERY FIGURE IS DERIVED. Nothing here is stored, cached or incremented. A
// count that can be recomputed and a count that is kept are two things that can
// disagree, and when they do it is always the stored one that is wrong and
// always the dashboard that gets believed.
//
// It also means these numbers are only ever as complete as the caller's SCOPE.
// A supervisor's dashboard sums the runs a supervisor may see, because that is
// what the server sent them. That is correct, and it is why every figure below
// takes its input as an argument rather than fetching anything itself.
//
// Pure — no react-native imports — so the self-check runs under tsx:
//   npx tsx lib/spaces/dashboard.ts

import { progress, type Run, type RunRider } from './runs';
import type { AttendanceState } from './attendance';

export interface RunSet {
  run: Run;
  riders: RunRider[];
}

export interface OpsTotals {
  /** Runs that are out right now. */
  active: number;
  scheduled: number;
  completed: number;
  /** Active runs the SERVER says have stopped reporting. */
  notReporting: number;
  /** Riders across every run in scope. */
  riders: number;
  boarded: number;
  pending: number;
  dropped: number;
  /** absent + no_show — to a dashboard they are the same fact: nobody got on. */
  notTravelling: number;
  /** 0..1 across every rider in scope; 1 when there is nothing to do. */
  fraction: number;
}

export function opsTotals(sets: RunSet[]): OpsTotals {
  const t: OpsTotals = {
    active: 0, scheduled: 0, completed: 0, notReporting: 0,
    riders: 0, boarded: 0, pending: 0, dropped: 0, notTravelling: 0, fraction: 1,
  };
  for (const { run, riders } of sets) {
    switch (run.status) {
      case 'started': t.active++; break;
      case 'scheduled': t.scheduled++; break;
      case 'completed': t.completed++; break;
      // 'cancelled' is counted in none of them on purpose: a cancelled run is
      // not work outstanding, not work done, and not a vehicle on the road.
    }
    // Staleness is only meaningful for a run that is supposed to be reporting.
    // A scheduled run has not started, so it is not "not reporting" — flagging
    // tomorrow's bus offline all night is how an alert becomes wallpaper.
    if (run.status === 'started' && run.stale) t.notReporting++;

    const p = progress(riders);
    t.riders += p.total;
    t.boarded += p.boarded;
    t.pending += p.pending;
    t.dropped += p.dropped;
    t.notTravelling += p.absent;
  }
  t.fraction = t.riders === 0 ? 1 : (t.riders - t.pending) / t.riders;
  return t;
}

/**
 * A school's roll call, from the run manifests alone.
 *
 * `unaccounted` is the figure that matters and the one a naive dashboard omits:
 * riders still pending on a run that has FINISHED. Nobody marked them either
 * way, so the record cannot say whether they travelled. It is not the same as
 * absent and must never be added to it.
 */
export interface RollCall {
  expected: number;
  travelled: number;
  notTravelling: number;
  stillOut: number;
  unaccounted: number;
}

export function rollCall(sets: RunSet[]): RollCall {
  const r: RollCall = { expected: 0, travelled: 0, notTravelling: 0, stillOut: 0, unaccounted: 0 };
  for (const { run, riders } of sets) {
    for (const rider of riders) {
      r.expected++;
      switch (rider.state) {
        case 'boarded':
          if (run.status === 'started') r.stillOut++;
          r.travelled++;
          break;
        case 'dropped':
          r.travelled++;
          break;
        case 'absent':
        case 'no_show':
          r.notTravelling++;
          break;
        case 'cancelled':
          r.expected--; // never expected in the first place
          break;
        default: // pending
          if (run.status === 'completed' || run.status === 'cancelled') r.unaccounted++;
          else r.stillOut++;
      }
    }
  }
  return r;
}

/** A dashboard tile: a number, a label, and whether it needs attention. */
export interface Tile {
  key: string;
  label: string;
  value: number;
  /** true → render in the attention colour. Never for a merely non-zero count. */
  alert?: boolean;
}

/**
 * The tiles a transport dashboard shows.
 *
 * `alert` is set only for things that are actually wrong. Pending riders on a
 * running route are the NORMAL state of a bus halfway round — colouring them red
 * would mean the dashboard is red every morning, and a dashboard that is always
 * red is a dashboard nobody reads.
 */
export function transportTiles(sets: RunSet[]): Tile[] {
  const t = opsTotals(sets);
  const roll = rollCall(sets);
  return [
    { key: 'active', label: 'Vehicles out', value: t.active },
    { key: 'boarded', label: 'On board', value: t.boarded },
    { key: 'pending', label: 'Still to collect', value: t.pending },
    { key: 'dropped', label: 'Dropped off', value: t.dropped },
    { key: 'not_travelling', label: 'Not travelling', value: t.notTravelling },
    { key: 'not_reporting', label: 'Not reporting', value: t.notReporting, alert: t.notReporting > 0 },
    { key: 'unaccounted', label: 'Unaccounted', value: roll.unaccounted, alert: roll.unaccounted > 0 },
  ];
}

/**
 * The tiles a SCHOOL shows, which is a roll call rather than a fleet report.
 *
 * A transport office asks "where are my vehicles"; a school asks "where are my
 * children". Same rows, different question, so the two boards are different
 * lists rather than one list with a vehicle count bolted on.
 *
 * `unaccounted` leads the alerts here for the same reason it exists at all: on
 * a school board it is the only figure that means go and look for someone.
 */
export function schoolTiles(sets: RunSet[]): Tile[] {
  const t = opsTotals(sets);
  const roll = rollCall(sets);
  return [
    { key: 'expected', label: 'Expected today', value: roll.expected },
    { key: 'travelled', label: 'Travelled', value: roll.travelled },
    { key: 'still_out', label: 'Still on a bus', value: roll.stillOut },
    { key: 'not_travelling', label: 'Not travelling', value: roll.notTravelling },
    { key: 'active', label: 'Buses out', value: t.active },
    { key: 'not_reporting', label: 'Not reporting', value: t.notReporting, alert: t.notReporting > 0 },
    { key: 'unaccounted', label: 'Unaccounted', value: roll.unaccounted, alert: roll.unaccounted > 0 },
  ];
}

/**
 * Pick the board for a space type.
 *
 * Keyed off the type because the QUESTION differs, not the styling: a school
 * counts children, a transport office counts vehicles, a workplace counts
 * people at desks. A single board that tried to serve all three would answer
 * none of them well.
 *
 * An unknown or absent type gets the transport board when there are runs and
 * nothing at all when there are not — a Family space has no operations, and an
 * empty operations board is worse than no board.
 */
export function tilesForType(groupType: string | null | undefined, sets: RunSet[]): Tile[] {
  switch (groupType) {
    case 'school':
    case 'school_transport':
      return schoolTiles(sets);
    case 'office_transport':
      return transportTiles(sets);
    case 'business':
    case 'office':
      // A workplace's board is attendance, which this function has no input
      // for — the caller renders attendanceTiles from its own projection. Runs
      // are still shown when a workplace happens to run cabs.
      return sets.length ? transportTiles(sets) : [];
    default:
      return sets.length ? transportTiles(sets) : [];
  }
}

/** The tiles a workplace dashboard shows, from attendance states. */
export function attendanceTiles(states: AttendanceState[]): Tile[] {
  const count = (s: AttendanceState) => states.filter((x) => x === s).length;
  const unknown = count('unknown');
  return [
    { key: 'present', label: 'Present', value: count('present') },
    { key: 'late', label: 'Late', value: count('late') },
    { key: 'left_early', label: 'Left early', value: count('left_early') },
    { key: 'absent', label: 'Absent', value: count('absent') },
    // Not an alert: "no data" is a gap in what we know, not an accusation. It is
    // shown so the other four are read in context rather than as the whole roll.
    { key: 'unknown', label: 'No data', value: unknown },
  ];
}

// ── self-check ──
if (require.main === module) {
  const run = (id: string, status: Run['status'], stale = false): Run => ({
    id, kind: 'school_pickup', name: id, driverId: 'd', vehicleLabel: id,
    scheduledAt: null, status, startedAt: null, completedAt: null,
    requireCode: false, stale,
  });
  const rider = (id: string, state: RunRider['state']): RunRider => ({
    riderId: id, stopId: null, state, stateAt: null, note: null, displayName: id,
  });

  // an empty board is complete, not stalled
  const empty = opsTotals([]);
  if (empty.fraction !== 1 || empty.active !== 0) throw new Error('empty totals wrong');

  const sets: RunSet[] = [
    { run: run('A', 'started'), riders: [rider('a1', 'boarded'), rider('a2', 'pending')] },
    { run: run('B', 'started', true), riders: [rider('b1', 'dropped'), rider('b2', 'absent')] },
    { run: run('C', 'scheduled', true), riders: [rider('c1', 'pending')] },
    { run: run('D', 'completed'), riders: [rider('d1', 'pending'), rider('d2', 'dropped')] },
    { run: run('E', 'cancelled'), riders: [rider('e1', 'cancelled')] },
  ];
  const t = opsTotals(sets);
  if (t.active !== 2) throw new Error(`active should be 2, got ${t.active}`);
  if (t.scheduled !== 1 || t.completed !== 1) throw new Error('status counts wrong');
  // a STALE SCHEDULED run is not "not reporting" — it has not started
  if (t.notReporting !== 1) throw new Error(`notReporting should be 1 (only the started one), got ${t.notReporting}`);
  if (t.riders !== 8) throw new Error(`riders should be 8, got ${t.riders}`);
  if (t.boarded !== 1 || t.dropped !== 2 || t.notTravelling !== 1) throw new Error('rider counts wrong');
  if (t.pending !== 3) throw new Error(`pending should be 3, got ${t.pending}`);

  // the roll call keeps "unaccounted" out of "not travelling"
  const roll = rollCall(sets);
  if (roll.unaccounted !== 1) throw new Error(`unaccounted should be 1 (pending on a completed run), got ${roll.unaccounted}`);
  if (roll.notTravelling !== 1) throw new Error('unaccounted must not be counted as not travelling');
  if (roll.travelled !== 3) throw new Error(`travelled should be 3, got ${roll.travelled}`);
  if (roll.stillOut !== 3) throw new Error(`stillOut should be 3, got ${roll.stillOut}`);
  // a cancelled rider was never expected
  if (roll.expected !== 7) throw new Error(`expected should be 7, got ${roll.expected}`);

  // recomputation is total: same input, same numbers, no accumulation anywhere
  const again = opsTotals(sets);
  if (JSON.stringify(again) !== JSON.stringify(t)) throw new Error('totals must be a pure function of their input');

  // tiles alert only on things that are actually wrong
  const tiles = transportTiles(sets);
  const byKey = Object.fromEntries(tiles.map((x) => [x.key, x]));
  if (byKey.pending.alert) throw new Error('pending riders on a running route are normal, not an alert');
  if (byKey.not_travelling.alert) throw new Error('a recorded absence is a fact, not an alert');
  if (!byKey.not_reporting.alert) throw new Error('a vehicle that stopped reporting IS an alert');
  if (!byKey.unaccounted.alert) throw new Error('an unaccounted rider IS an alert');
  // and not when the count is zero
  const calm = transportTiles([{ run: run('X', 'started'), riders: [rider('x1', 'boarded')] }]);
  if (calm.some((x) => x.alert)) throw new Error('a healthy board must have no alerts');

  // a school board answers a different question from a transport board
  const school = schoolTiles(sets);
  const schoolKeys = school.map((x) => x.key);
  if (!schoolKeys.includes('expected')) throw new Error('a school board must lead with who was expected');
  if (schoolKeys.includes('boarded')) throw new Error('a school board counts children, not boardings');
  const schoolByKey = Object.fromEntries(school.map((x) => [x.key, x]));
  if (schoolByKey.expected.value !== roll.expected) throw new Error('school tiles must agree with the roll call');
  if (!schoolByKey.unaccounted.alert) throw new Error('unaccounted must alert on a school board too');

  // type routing picks the board by the QUESTION being asked
  if (tilesForType('school', sets).map((x) => x.key).join() !== schoolKeys.join()) {
    throw new Error('school types should get the school board');
  }
  if (tilesForType('school_transport', sets)[0].key !== 'expected') throw new Error('school transport is still a school');
  if (tilesForType('office_transport', sets)[0].key !== 'active') throw new Error('a cab fleet gets the fleet board');
  // a space with no runs at all gets no board rather than a row of zeros
  if (tilesForType('family', []).length !== 0) throw new Error('a family space has no operations board');
  if (tilesForType(null, []).length !== 0) throw new Error('an untyped space with no runs has no board');
  if (tilesForType(null, sets).length === 0) throw new Error('an untyped space WITH runs still gets one');

  // attendance tiles keep unknown separate and never flag it
  const att = attendanceTiles(['present', 'late', 'absent', 'unknown', 'unknown']);
  const attByKey = Object.fromEntries(att.map((x) => [x.key, x]));
  if (attByKey.unknown.value !== 2) throw new Error('unknown count wrong');
  if (attByKey.absent.value !== 1) throw new Error('unknown must not be folded into absent');
  if (att.some((x) => x.alert)) throw new Error('no attendance figure is an accusation');

  console.log('spaces/dashboard self-check OK');
}
