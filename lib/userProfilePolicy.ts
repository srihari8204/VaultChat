// lib/userProfilePolicy.ts — the typed representation of GET /user/profile.
//
// protobuf-migration. The client half of userProfileWrite
// (vaultchat-backend-go/internal/routes/user.go) and proto/ccwire/v1/
// user_profile.proto. Same split as lib/termsPolicy.ts: no react-native
// imports, so lib/userProfileNegotiation.selftest.ts can run it under plain
// Node.
//
// There is no policy DECISION here, only a representation — /user/profile is
// data, not a gate. It lives in a *Policy module anyway because that is where
// the other decoders live, and because being react-native-free is the property
// that makes it testable.

/**
 * Exactly what userUsersRow.public() writes (user.go:168-187), key for key.
 *
 * Nullable columns are `string | null`, NOT optional: the JSON always writes
 * the key, with an explicit null. See profileFromProtobuf for why the
 * difference bites.
 */
export interface UserProfile {
  id: string;
  email: string | null;
  name: string | null;
  phone: string | null;
  /** JSON key is photoURL — capital URL — while the proto field is photo_url. */
  photoURL: string | null;
  vaultId: string | null;
  dob: string | null;
  status: string | null;
  online: boolean;
  lastSeen: string | null;
  authProvider: string | null;
  hasPin: boolean;
  faceCount: number;
  emailVerifiedAt: string | null;
  createdAt: string;
}

/**
 * The protobuf body (ccwire.v1.UserProfile).
 *
 * DECODES TO THE SAME OBJECT THE JSON PATH PRODUCES, key for key and type for
 * type. Three things make that non-obvious:
 *
 *   1. `?? null`, never undefined and never a conditional key. proto3 absence
 *      arrives as undefined and the JSON writes an explicit null, and
 *      JSON.stringify DROPS undefined — so an undefined here compares equal
 *      through a stringify and unequal through `in` or Object.keys. This row is
 *      cached: app/(tabs)/profile.tsx writes it with writeCache('my-profile')
 *      and paints from that cache on the next cold open, so a key that
 *      evaporates on the typed path only is exactly the difference that shows
 *      up months later on one device.
 *   2. `photoURL`, not `photoUrl`. protoc-gen-es lower-camels `photo_url`; the
 *      JSON has always spelled it with a capital URL and every screen reads
 *      that spelling.
 *   3. `status` distinguishes null ("never set") from "" ("deliberately
 *      cleared"), which is why it is `optional` on the wire. `?? null` keeps
 *      both: an empty string is a value and survives, absence becomes null.
 *
 * IT THROWS ON BAD BYTES, DELIBERATELY, like every other decoder here: the
 * bytes are spent by the time it runs, so there is no JSON to fall back to
 * without re-issuing the GET. Throwing makes a corrupt body look exactly like a
 * failed fetch, which every call site already handles — authService returns
 * false, the profile tab keeps what it painted from the cache. A
 * default-filled object would instead look like a real, empty profile.
 *
 * The dynamic import carries NO `.js` suffix: tsc accepts one, Metro cannot
 * resolve it (see lib/appVersionPolicy.ts). It also keeps @bufbuild/protobuf
 * off the cold-start path until a server actually answers in binary — and this
 * endpoint IS the cold-start path.
 */
export async function profileFromProtobuf(bytes: Uint8Array): Promise<UserProfile> {
  const { UserProfile: Wire } = await import('./ccwire/gen/ccwire/v1/user_profile_pb');
  const m = Wire.fromBinary(bytes);
  return {
    id: m.id,
    email: m.email ?? null,
    name: m.name ?? null,
    phone: m.phone ?? null,
    photoURL: m.photoUrl ?? null,
    vaultId: m.vaultId ?? null,
    dob: m.dob ?? null,
    status: m.status ?? null,
    online: m.online,
    lastSeen: m.lastSeen ?? null,
    authProvider: m.authProvider ?? null,
    hasPin: m.hasPin,
    faceCount: m.faceCount,
    emailVerifiedAt: m.emailVerifiedAt ?? null,
    createdAt: m.createdAt,
  };
}
