// lib/groups/privacy.ts — per-member, per-group location privacy
// (Groups & Circles, G3.4/G3.5).
//
// THE WHOLE POINT: privacy is applied BEFORE the payload is sealed.
//
// It would be far easier to seal the precise position and have the receiving
// client blur it for display. That would be theatre. Everyone in the group
// would still hold your exact coordinates, and "approximate" would mean nothing
// the moment someone ran a modified client. So the reduction happens here, on
// the publishing device, and the precise coordinate never leaves it.
//
// Naming: the "hide me entirely" mode is called INVISIBLE, never "ghost".
// "Ghost" historically meant the duress/decoy-account wipe here (that feature
// has since been removed), so the word stays retired to avoid confusion with
// anything destructive.
//
// Pure — no react-native imports — so the self-check runs under tsx:
//   npx tsx lib/groups/privacy.ts

/** How precisely I share my position with one group. */
export type LocationPrecision = 'precise' | 'approximate' | 'off';

export interface GroupPrivacy {
  precision: LocationPrecision;
  hideBattery: boolean;
  hideSpeed: boolean;
  /** Publish nothing at all to this group, without changing the other settings. */
  invisible: boolean;
  /** Temporary sharing: epoch ms after which publishing stops. null = indefinite. */
  sharingUntil: number | null;
}

export const DEFAULT_GROUP_PRIVACY: GroupPrivacy = {
  precision: 'precise',
  hideBattery: false,
  hideSpeed: false,
  invisible: false,
  sharingUntil: null,
};

/**
 * Grid size for approximate sharing, in degrees. 0.005° is roughly 550 m of
 * latitude — a neighbourhood, not a doorstep.
 *
 * Snapping to a GRID rather than adding noise is deliberate: random jitter
 * leaks the true position under averaging, because repeated samples cluster
 * around the real point. A grid cell is stable — stand still and every sample
 * reports the identical coordinate, revealing only which cell you are in.
 */
export const APPROX_GRID_DEG = 0.005;

/** Snap a coordinate to the centre of its grid cell. */
export function snapToGrid(value: number, step = APPROX_GRID_DEG): number {
  const cell = Math.round(value / step) * step;
  // Kill binary float dust so the same cell always serialises identically.
  return Number(cell.toFixed(6));
}

/** The subset of a ping that privacy can act on. */
export interface PublishablePing {
  lat: number;
  lng: number;
  bat?: number;
  chg?: boolean;
  spd?: number;
  /** GPS accuracy in metres, as reported by the device. */
  acc?: number;
  ts: number;
}

/** Has a temporary-sharing window closed? */
export function sharingExpired(p: GroupPrivacy, now: number): boolean {
  return p.sharingUntil != null && now >= p.sharingUntil;
}

/** Would anything at all be published to this group right now? */
export function isPublishing(p: GroupPrivacy, now: number): boolean {
  if (p.invisible) return false;
  if (p.precision === 'off') return false;
  if (sharingExpired(p, now)) return false;
  return true;
}

/**
 * Reduce a ping to what this group is allowed to receive.
 *
 * Returns null when nothing should be published — invisible, precision off, or
 * a temporary window that has closed. A null result MUST be treated as "send
 * nothing", not as "send an empty ping".
 */
export function applyPrivacy(
  ping: PublishablePing,
  privacy: GroupPrivacy,
  now: number,
): PublishablePing | null {
  if (!isPublishing(privacy, now)) return null;

  const out: PublishablePing = { ...ping };

  if (privacy.precision === 'approximate') {
    out.lat = snapToGrid(ping.lat);
    out.lng = snapToGrid(ping.lng);
    // Speed would re-reveal movement the coarse position is meant to hide —
    // 60 km/h through a 550 m cell says a great deal about which road you are
    // on. Approximate therefore always drops speed, regardless of hideSpeed.
    delete out.spd;
    // Accuracy goes with it, for two reasons. It is MISLEADING once the
    // coordinate has been snapped — "accurate to 5 m" is false of a point moved
    // up to half a grid cell — and it advertises that the underlying fix was
    // precise, which is exactly what approximate exists to withhold. A viewer
    // seeing no accuracy for an approximate member is correct: they genuinely
    // do not know it.
    delete out.acc;
  }

  if (privacy.hideBattery) {
    delete out.bat;
    delete out.chg;
  }
  if (privacy.hideSpeed) delete out.spd;

  return out;
}

/**
 * Merge a stored (possibly partial, possibly from an older build) privacy
 * record onto the defaults. An unreadable value falls back to the DEFAULT, not
 * to the most permissive option.
 */
export function normalizePrivacy(raw: Partial<GroupPrivacy> | null | undefined): GroupPrivacy {
  if (!raw) return { ...DEFAULT_GROUP_PRIVACY };
  const precision: LocationPrecision =
    raw.precision === 'approximate' || raw.precision === 'off' || raw.precision === 'precise'
      ? raw.precision
      : DEFAULT_GROUP_PRIVACY.precision;
  return {
    precision,
    hideBattery: raw.hideBattery === true,
    hideSpeed: raw.hideSpeed === true,
    invisible: raw.invisible === true,
    sharingUntil: typeof raw.sharingUntil === 'number' && raw.sharingUntil > 0 ? raw.sharingUntil : null,
  };
}

/** Human summary for the privacy row on the group dashboard. */
export function describePrivacy(p: GroupPrivacy, now: number): string {
  if (p.invisible) return 'Invisible';
  if (p.precision === 'off') return 'Location off';
  if (sharingExpired(p, now)) return 'Sharing ended';
  const base = p.precision === 'approximate' ? 'Approximate location' : 'Precise location';
  if (p.sharingUntil != null) {
    const mins = Math.max(1, Math.round((p.sharingUntil - now) / 60000));
    return `${base} · ${mins < 60 ? `${mins}m left` : `${Math.round(mins / 60)}h left`}`;
  }
  return base;
}

// ── self-check ──
if (require.main === module) {
  const now = 1_700_000_000_000;
  const base: PublishablePing = { lat: 12.971598, lng: 77.594562, bat: 80, chg: false, spd: 12, ts: now };
  const P = (o: Partial<GroupPrivacy> = {}): GroupPrivacy => ({ ...DEFAULT_GROUP_PRIVACY, ...o });

  // 1. precise passes everything through untouched
  const precise = applyPrivacy(base, P(), now)!;
  if (precise.lat !== base.lat || precise.lng !== base.lng) throw new Error('precise must not alter position');
  if (precise.bat !== 80 || precise.spd !== 12) throw new Error('precise must keep battery and speed');

  // 2. approximate actually MOVES the coordinate, and by a meaningful amount
  const approx = applyPrivacy(base, P({ precision: 'approximate' }), now)!;
  if (approx.lat === base.lat && approx.lng === base.lng) throw new Error('approximate must change the coordinate');
  const dLat = Math.abs(approx.lat - base.lat), dLng = Math.abs(approx.lng - base.lng);
  if (dLat > APPROX_GRID_DEG || dLng > APPROX_GRID_DEG) throw new Error('snap moved further than one cell');
  // …and drops speed, which would otherwise undo the blurring
  if (approx.spd !== undefined) throw new Error('approximate must drop speed');

  // 3. THE grid property: jitter inside one cell yields an IDENTICAL output, so
  //    averaging repeated samples cannot recover the true position.
  const jittered = [0.0001, -0.0002, 0.00035, -0.00011].map((d) =>
    applyPrivacy({ ...base, lat: base.lat + d, lng: base.lng - d }, P({ precision: 'approximate' }), now)!);
  const first = `${jittered[0].lat},${jittered[0].lng}`;
  for (const j of jittered) {
    if (`${j.lat},${j.lng}` !== first) throw new Error('grid must be stable under jitter — averaging would leak');
  }

  // 4. nothing at all is published when it should not be
  if (applyPrivacy(base, P({ invisible: true }), now) !== null) throw new Error('invisible must publish nothing');
  if (applyPrivacy(base, P({ precision: 'off' }), now) !== null) throw new Error('off must publish nothing');
  if (applyPrivacy(base, P({ sharingUntil: now - 1 }), now) !== null) throw new Error('expired window must publish nothing');
  if (applyPrivacy(base, P({ sharingUntil: now + 60_000 }), now) === null) throw new Error('live window must publish');

  // 5. invisible beats an otherwise-live temporary window
  if (applyPrivacy(base, P({ invisible: true, sharingUntil: now + 60_000 }), now) !== null) {
    throw new Error('invisible must win over a live sharing window');
  }

  // 6. field hiding
  const noBat = applyPrivacy(base, P({ hideBattery: true }), now)!;
  if (noBat.bat !== undefined || noBat.chg !== undefined) throw new Error('hideBattery must drop bat and chg');
  if (noBat.lat !== base.lat) throw new Error('hiding battery must not move the position');
  const noSpd = applyPrivacy(base, P({ hideSpeed: true }), now)!;
  if (noSpd.spd !== undefined) throw new Error('hideSpeed must drop speed');

  // 7. the original ping is never mutated — callers reuse it across groups
  if (base.spd !== 12 || base.bat !== 80) throw new Error('applyPrivacy must not mutate its input');

  // 8. normalize falls back to the DEFAULT, never to the most permissive
  const junk = normalizePrivacy({ precision: 'whatever' as any, hideBattery: 'yes' as any });
  if (junk.precision !== 'precise') throw new Error('unknown precision should fall back to the default');
  if (junk.hideBattery !== false) throw new Error('non-boolean must coerce to false');
  if (normalizePrivacy(null).invisible !== false) throw new Error('null should give defaults');
  if (normalizePrivacy({ sharingUntil: -5 }).sharingUntil !== null) throw new Error('bad expiry should clear');

  // 9. snapToGrid centres and is symmetric around zero
  if (snapToGrid(0) !== 0) throw new Error('zero should snap to zero');
  if (snapToGrid(-12.9716) !== -snapToGrid(12.9716)) throw new Error('snap should be symmetric');

  // 10. descriptions
  if (describePrivacy(P({ invisible: true }), now) !== 'Invisible') throw new Error('invisible label');
  if (!describePrivacy(P({ sharingUntil: now + 30 * 60_000 }), now).includes('30m left')) throw new Error('countdown label');
  if (describePrivacy(P({ sharingUntil: now - 1 }), now) !== 'Sharing ended') throw new Error('expired label');

  // accuracy is dropped with the coordinate under approximate — reporting it
  // would claim a precision the snapped position does not have
  const withAcc = { lat: 12.9716, lng: 77.5946, spd: 10, acc: 5, ts: 1 };
  const accApprox = applyPrivacy(withAcc, { ...DEFAULT_GROUP_PRIVACY, precision: 'approximate' }, 1);
  if (accApprox?.acc !== undefined) throw new Error('approximate must not report GPS accuracy');
  if (accApprox?.spd !== undefined) throw new Error('approximate must not report speed');
  const accPrecise = applyPrivacy(withAcc, { ...DEFAULT_GROUP_PRIVACY, precision: 'precise' }, 1);
  if (accPrecise?.acc !== 5) throw new Error('precise should keep accuracy');

  console.log('groups/privacy self-check OK');
}
