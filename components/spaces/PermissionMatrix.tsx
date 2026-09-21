// components/spaces/PermissionMatrix.tsx — what a role can and cannot do.
//
// Reusable and informational. It renders the SERVER'S catalog entry and nothing
// else: no resolution, no inference, no local permission model. There is exactly
// one authority for what a role grants (group_type_config.role_catalog, enforced
// in internal/groups), and a second one living in the app would drift from it
// the first time either changed.
//
// ── THE DISTINCTION THIS COMPONENT EXISTS TO PRESERVE ──
//
//   permissions === null  →  "Inherits the standard <rank> permissions"
//   permissions === []    →  "No permissions of its own"
//
// These are NOT the same statement and must never be collapsed. `null` means the
// catalog is silent and the rank default applies — a set this app cannot
// enumerate, because the type default lives server-side. `[]` means the catalog
// deliberately grants nothing, which is what a school parent holds: their access
// to their own child comes from space_links, not from a permission.
//
// Rendering `null` as an empty list would tell an administrator that a Super
// Admin can do nothing. Rendering `[]` as "inherits" would tell them a parent
// can see the whole school. Both are worse than saying less.
//
// It never edits. Roles change through setRoleKey() and the server re-checks;
// there is no per-permission endpoint and this component must not imply one.

import { AppText as Text } from '../ui/Text';
import React, { useMemo } from 'react';
import { View, StyleSheet } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useTheme } from '../../lib/theme';
import type { Palette } from '../../constants/theme';
import { ALL_PERMISSIONS, PERMISSION_LABELS, type RoleDef } from '../../lib/groups/permissions';
import { rankLabel } from '../../lib/spaces/rolepicker';

export interface PermissionMatrixProps {
  /** The catalog entry to describe. null while loading, undefined if unknown. */
  role?: RoleDef | null;
  /**
   * True while the space's catalog is still being fetched. Kept separate from
   * `role == null` so a slow network never renders as "no permissions" — a
   * loading state that looks like an answer is worse than a spinner.
   */
  loading?: boolean;
  /** Why the catalog could not be read. Shown instead of guessing. */
  error?: string | null;
  /** Show the full ALL_PERMISSIONS table rather than only what is granted. */
  showWithheld?: boolean;
}

/** Human label, falling back to a readable form of the key — never mutating it. */
function label(p: string): string {
  const known = (PERMISSION_LABELS as Record<string, string>)[p];
  if (known) return known;
  // No label in the mirror: make it readable without inventing a meaning.
  return p.replace(/_/g, ' ').replace(/^\w/, (c) => c.toUpperCase());
}

export default function PermissionMatrix({
  role, loading, error, showWithheld = true,
}: PermissionMatrixProps) {
  const { colors } = useTheme();
  const s = styles(colors);

  const granted = useMemo(
    () => new Set(role?.permissions ?? []),
    [role?.permissions],
  );

  if (loading) {
    return (
      <View style={s.box}>
        <Text style={s.muted}>Loading this space’s roles…</Text>
      </View>
    );
  }

  // A failed catalog fetch is stated, not papered over. Inventing a permission
  // list here would be a lie an administrator might act on.
  if (error) {
    return (
      <View style={[s.box, { borderColor: colors.danger, borderWidth: 1 }]}>
        <View style={s.row}>
          <Ionicons name="alert-circle" size={16} color={colors.danger} />
          <Text style={[s.muted, { color: colors.danger, flex: 1 }]}>
            {error} Permissions cannot be shown without the space’s role list.
          </Text>
        </View>
      </View>
    );
  }

  if (!role) {
    return (
      <View style={s.box}>
        <Text style={s.muted}>Choose a role to see what it allows.</Text>
      </View>
    );
  }

  // ── null: the catalog is silent, so the rank default applies ──
  if (role.permissions == null) {
    return (
      <View style={s.box}>
        <Text style={s.title}>{role.label}</Text>
        <View style={s.row}>
          <Ionicons name="information-circle-outline" size={16} color={colors.textDim} />
          <Text style={[s.muted, { flex: 1 }]}>
            Inherits the standard {rankLabel(role.rank)} permissions. This space’s type
            decides what those are, and the server applies them — they are not listed
            here because this app is not the authority on them.
          </Text>
        </View>
      </View>
    );
  }

  // ── []: granted nothing, deliberately ──
  if (role.permissions.length === 0) {
    return (
      <View style={s.box}>
        <Text style={s.title}>{role.label}</Text>
        <View style={s.row}>
          <Ionicons name="lock-closed-outline" size={16} color={colors.textDim} />
          <Text style={[s.muted, { flex: 1 }]}>
            No permissions of its own. Anyone holding this role sees only what they are
            individually linked to — a parent sees their own child, and nothing else in
            the space.
          </Text>
        </View>
      </View>
    );
  }

  // ── an explicit list: show exactly it ──
  const rows = showWithheld
    ? ALL_PERMISSIONS.map(String)
    // Preserve the catalog's own order when only showing what is granted.
    : role.permissions;

  return (
    <View style={s.box}>
      <Text style={s.title}>{role.label}</Text>
      <Text style={s.sub}>
        {rankLabel(role.rank)} · {role.permissions.length} permission
        {role.permissions.length === 1 ? '' : 's'}
      </Text>

      {rows.map((p) => {
        const on = granted.has(p as any);
        return (
          <View key={p} style={s.line}>
            {/* An icon AND a word. A tick that differs from a dash only by
                colour is not a status a colour-blind administrator can read. */}
            <Ionicons
              name={on ? 'checkmark-circle' : 'remove-circle-outline'}
              size={16}
              color={on ? colors.success : colors.textFaint}
            />
            <Text style={[s.perm, !on && { color: colors.textFaint }]} numberOfLines={1}>
              {label(p)}
            </Text>
            <Text style={[s.state, { color: on ? colors.success : colors.textFaint }]}>
              {on ? 'Allowed' : 'No'}
            </Text>
          </View>
        );
      })}

      <Text style={s.foot}>
        Set by this space’s role list. Every action is checked again on the server, so
        this describes what will be allowed rather than deciding it.
      </Text>
    </View>
  );
}

const styles = (c: Palette) => StyleSheet.create({
  box: { backgroundColor: c.bg, borderRadius: 12, padding: 12, gap: 8 },
  title: { color: c.text, fontSize: 14.5, fontWeight: '800' },
  sub: { color: c.textDim, fontSize: 11.5, fontWeight: '700' },
  row: { flexDirection: 'row', alignItems: 'flex-start', gap: 8 },
  muted: { color: c.textDim, fontSize: 12.5, lineHeight: 17 },
  line: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  perm: { color: c.text, fontSize: 13, flex: 1 },
  state: { fontSize: 11, fontWeight: '800' },
  foot: { color: c.textFaint, fontSize: 11, lineHeight: 15, marginTop: 4 },
});
