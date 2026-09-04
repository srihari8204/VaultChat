package jobs

// MetaPublicKeys is the allow-list of message-meta keys the server keeps
// permanently. Everything else is message CONTENT and is reclaimed alongside
// the ciphertext by delete-on-delivery.
//
// WHY THIS LIVES HERE AND NOT IN routes
//
// It was defined in routes (chats_bodies.go) as the split used when writing to
// the ephemeral body store. But that store is refused at boot — its 3-hour
// schema cap cannot satisfy the 30-day retention floor — so the split never
// runs, and the FULL meta goes onto the durable spine on every send.
//
// That is not a cosmetic gap. `meta` is plaintext JSONB and carries a base64
// JPEG preview of every photo and video (`meta.thumb`), plus filenames, MIME
// types, poll option TEXT and mention display names. Measured on production:
// 22 of 24 image/video messages had a server-readable preview.
//
// So delete-on-delivery, which nulls `content`, would have reclaimed the
// ciphertext and left a legible picture of it on the server forever — the exact
// outcome the body store's own header warns about. The sweep therefore has to
// apply this same split, which means the list has to be reachable from `jobs`.
// `routes` imports `jobs`, so this is the direction that has no cycle.
//
// ONE definition, used by both. Two copies of a security allow-list is how the
// writer and the reclaimer come to disagree about what is private.
//
// Each key earns its place by being read by SERVER code:
//
//	attachmentId   uploads.go authorises downloads by joining meta->>'attachmentId'
//	viewOnce       uploads.go gates the one-shot view
//	revoked        uploads.go media revoke
//	announcement   chatsMessagePost enforces PermSendAnnouncement
//	audience       chatsAudienceAllowed validates the addressed subtree
//	silent         chatsSendMessagePush suppresses the push
//	groupId        chatsValidateGroupRef validates the card
//	gifUrl         validated server-side against chatsGifURLRe (a public URL anyway)
//	allowMultiple  poll vote handler
//	optionCount    poll vote handler — DERIVED from options, see below
//	mentionUserIds push override for muted chats — DERIVED from mentions
//	encrypted      render hint the client needs BEFORE it has the body
//
// An ALLOW-list, never a deny-list. A deny-list fails open: the next feature to
// add a meta field would leave it on the spine by default and nobody would
// notice until it was audited.
var MetaPublicKeys = []string{
	"attachmentId", "viewOnce", "revoked",
	"announcement", "audience", "silent",
	"groupId", "gifUrl",
	"allowMultiple", "optionCount",
	"mentionUserIds", "encrypted",
	// game_invite: chatsMessagePost validates both (chatsGameKinds and
	// chatsGameRoomRe) and the recipient opens a URL built from them, so they
	// are inherently server-visible. They were missing from the original list,
	// which meant the split would have stripped them and broken every game
	// invite the moment it was switched on.
	"game", "room",
}

// MetaPublicKeySet is the same list as a lookup, for the write-side split.
var MetaPublicKeySet = func() map[string]bool {
	m := make(map[string]bool, len(MetaPublicKeys))
	for _, k := range MetaPublicKeys {
		m[k] = true
	}
	return m
}()
