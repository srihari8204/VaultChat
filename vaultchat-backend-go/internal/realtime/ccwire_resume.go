package realtime

// ccwire_resume.go — logical session resume.
//
// WHY THIS EXISTS
//
// Every transport interruption currently costs a full application resync. A
// two-second tunnel, a Wi-Fi→cellular handover or a backgrounded app throws away
// the logical session, and the client rebuilds it from durable state. The
// protocol was designed for better than that and the server never implemented
// it: ClientHello.resume_token (7), ClientHello.resume_from (8),
// ServerHello.resume_token (6), ServerHello.resumed (8) and
// Capabilities.resumption (2) have all existed in the schema and been ignored.
//
// So this file implements what the wire format already promises. It adds no
// protobuf field and changes no application event.
//
// THE GOVERNING RULE
//
// Resume is an OPTIMISATION over the existing resync, never a replacement for
// it. Every uncertain branch here answers "not resumed" and lets the client do
// exactly what it does today. That is why the worst case of this feature is the
// current behaviour — and it is why the code below refuses far more often than
// it accepts.
//
// WHAT RESUME DOES AND DOES NOT RESTORE
//
// Restores: session identity, device binding, subscriptions, and the cursor
// positions the session had reached.
//
// Does NOT restore missed frames. There is no replay window yet
// (openspec/changes/ccwire-replay-window). A resumed client keeps its place and
// its subscriptions; it still reconciles content through the existing sync
// path. Saying otherwise would be the dangerous kind of wrong.
//
// SECURITY
//
// A resume token is an authentication-adjacent credential: a guessable or
// misbound one is an account-takeover primitive. Hence, deliberately:
//
//   - 32 bytes from crypto/rand, and a failing RNG refuses rather than degrades
//   - opaque: the token carries NO uid, device or session id. It cannot be
//     tampered with because it says nothing
//   - bound to (uid, deviceID): presenting it as another user or another device
//     is refused even when the bytes are right
//   - single-use: consumed on resume, a fresh one issued. A captured token is
//     worth one race, not a standing capability
//   - constant-time comparison, via the same sha256+subtle path safeKeyEqual
//     already uses for ADMIN_KEY
//
// Resume never substitutes for authentication. httpx.RequireAuth still runs at
// the upgrade; resume only avoids rebuilding state after auth has succeeded.

import (
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"os"
	"sync"
	"time"

	"vaultchat/backend-go/internal/ccwire"
	"vaultchat/backend-go/internal/metrics"
)

// resumptionEnabled gates the whole feature behind CCWIRE_RESUME=1.
//
// OFF by default, and that is the safe-rollout requirement, not timidity: with
// the flag unset the server advertises no `resumption` capability, so no client
// offers a token, tryResume never runs, and behaviour is byte-for-byte what it
// is today. The flag is what lets this reach internal devices first and widen
// only once the metrics say it behaves.
func resumptionEnabled() bool { return os.Getenv("CCWIRE_RESUME") == "1" }

// hashToken keeps the token's hash rather than the token in the parked record,
// so a memory dump yields nothing usable. Same sha256-then-compare shape
// safeKeyEqual already uses for ADMIN_KEY.
// hashKey is the table key: the token's hash, as a string so it can index a
// map. Distinct from hashToken's array only by shape.
func hashKey(tok string) []byte {
	h := hashToken(tok)
	return h[:]
}

func hashToken(tok string) [32]byte { return sha256.Sum256([]byte(tok)) }

// equalConstTime compares two hashes without leaking through timing.
func equalConstTime(a, b [32]byte) bool {
	return subtle.ConstantTimeCompare(a[:], b[:]) == 1
}

const (
	// resumeTokenBytes is 256 bits — comfortably past the 128 the spec requires,
	// and cheap: one allocation per disconnect.
	resumeTokenBytes = 32

	// resumeLifetime bounds how long a parked session is worth keeping. Long
	// enough for the interruptions this exists for (tunnel, handover, a short
	// backgrounding), short enough that a stolen token is nearly always already
	// dead. Beyond this the client resyncs, which it does correctly today.
	resumeLifetime = 2 * time.Minute

	// maxParkedSessions bounds the table. An unbounded session map is how this
	// feature turns a mobile-network event into a gateway outage: every phone
	// that walks into a lift parks state here.
	maxParkedSessions = 20000

	// evictBatch is how many are shed when the table is full. Amortises the
	// O(len) scan: one scan per evictBatch parks rather than one per park.
	evictBatch = 256

	// sweepInterval gates the full-table scan. See resumeStore.lastSweep.
	sweepInterval = 5 * time.Second

	// resumeSweepInterval is the periodic sweep, for a gateway with no traffic
	// to piggy-back on.
	resumeSweepInterval = 30 * time.Second

	// replayParkedBudget caps replay bytes held across ALL parked sessions.
	// Past it, sessions park without their window: resume still works, replay
	// refuses, the client resyncs. Shedding the optimisation under pressure is
	// the whole point — the alternative is shedding the process.
	replayParkedBudget = 64 << 20
)

// parkedSession is what survives a disconnect.
//
// Identity, position, and — once ccwire-replay-window landed — the bounded ring
// of frames the client had not acknowledged. Those frames ARE payload, so the
// earlier "no payload of any kind" rule no longer holds and is not restated
// here: it would be a comment asserting something the type contradicts.
//
// What replaces it is a bound rather than a prohibition. A window is parked
// only while the gateway-wide budget below allows, is per-session bounded three
// ways already, and dies with the parked session. Nothing here is durable, and
// nothing here is a copy of anything PostgreSQL does not already hold.
type parkedSession struct {
	sessionID string
	uid       string
	deviceID  string

	// tokenHash, never the token. The table is a lookup by token, so the token
	// itself is the key; this is the second half of the constant-time check and
	// means a memory dump does not yield usable credentials.
	tokenHash [32]byte

	// generation increments on every successful resume. A frame arriving on an
	// older generation must not advance state — see supersedes().
	generation uint64

	subs      []string
	cursors   map[uint32]uint64 // stream → last_delivered_seq the server SENT
	parkedAt  time.Time
	expiresAt time.Time

	// missedAtPark is resumeStore.missedByUID[uid] when this session parked. A
	// resume is refused if it has moved, because a fan-out that happened while
	// this session was parked reached nothing and recorded no hole.
	missedAtPark uint64

	// replay is the unacknowledged tail, or nil when the gateway budget was
	// exhausted at park time. Nil is not a failure: the resume still succeeds
	// on identity and position, the window refuses, and the client resyncs.
	replay *replayWindow
}

// resumeStore is the gateway's parked-session table.
//
// Deliberately in-memory and process-local. A restart invalidates every token,
// so a rolling deploy resyncs every client — acceptable, honest, and the reason
// GoAway-plus-resume matters later. Cross-node resume does NOT work and must
// not be claimed: a token issued by gateway A simply will not resolve on B,
// which answers resumed=false and costs the client nothing but a resync.
type resumeStore struct {
	mu      sync.Mutex
	byToken map[string]*parkedSession

	// replayBytes is the total retained across every parked window.
	//
	// The per-session bounds in ccwire_replay.go do not bound the gateway:
	// maxParkedSessions × replayMaxBytes is 5 GB, which is a per-session bound
	// and a process-wide outage at the same time. This is the bound that
	// actually holds, and it is checked on park, not on a sweep.
	replayBytes int

	// lastSweep gates the full-table scan. Sweeping on every park made park()
	// O(len): at 20k parked sessions a reconnect storm spent all its time
	// rescanning the table it was trying to add to. Measured: 20.5k parks took
	// 12s with a sweep each time. The sweep is a janitor, not a precondition —
	// an entry that lingers a few seconds past expiry is refused on take()
	// anyway, because take() checks expiresAt itself.
	lastSweep time.Time

	// missedByUID counts fan-outs that happened while a user had at least one
	// session parked.
	//
	// THE HOLE THIS CLOSES. A parked session is not in h.cwSessions, so the
	// fan-out never reaches it: no seq is allocated, nothing is retained, and —
	// the part that bites — no HOLE is recorded. since() therefore has nothing
	// to refuse on and answers "resumed, nothing missing" for a message the
	// client never saw and will not resync for. The gap is precisely the tunnel
	// the whole feature exists to cover.
	//
	// A counter rather than a flag per session, so a park that happens BETWEEN
	// two fan-outs is not retroactively blamed for the earlier one: each parked
	// session records the count at park time and is refused only if the count
	// has moved since.
	//
	// Keyed by uid and pruned with the last parked session for that uid, so it
	// cannot outgrow the table it shadows.
	missedByUID map[string]uint64
	parkedByUID map[string]int
}

func newResumeStore() *resumeStore {
	return &resumeStore{
		byToken:     map[string]*parkedSession{},
		missedByUID: map[string]uint64{},
		parkedByUID: map[string]int{},
	}
}

// newResumeToken returns an opaque token. An error from the RNG is fatal to the
// token, never papered over: a predictable resume token is worse than none, so
// the caller simply does not offer resume.
func newResumeToken() (string, bool) {
	b := make([]byte, resumeTokenBytes)
	if _, err := rand.Read(b); err != nil {
		metrics.Inc("ccwire_resume_token_rng_failed")
		return "", false
	}
	return base64.RawURLEncoding.EncodeToString(b), true
}

// park stores state for a disconnecting session and returns its token.
//
// Returns ("", false) when resume cannot be offered — no session id, no RNG, or
// the table is full. Every one of those is a normal outcome, not an error: the
// client resyncs.
func (r *resumeStore) park(s *ccwireSession, cursors map[uint32]uint64, subs []string, window *replayWindow, gen uint64) (string, bool) {
	if s == nil || s.sessionID == "" || s.d == nil || s.d.uid == "" {
		return "", false
	}
	// The token was minted at ServerHello and the client has been holding it
	// ever since. Minting one HERE would be useless: the connection is already
	// gone by the time a session parks, so there is nobody left to tell.
	//
	// Until this moment the token resolves to nothing, which is correct —
	// resume is meaningless while the session is still live.
	// Under pos.mu, because revokeLiveResume writes this field under it. A Go
	// string is two words; a torn read yields one session's pointer with
	// another's length, which at best hashes to an entry nobody can ever
	// resolve and which holds its replay bytes until the sweep.
	s.pos.mu.Lock()
	tok := s.resumeToken
	s.pos.mu.Unlock()
	if tok == "" {
		return "", false
	}

	// cursors and subs were snapshotted by the caller under the locks that
	// guard them; copying again here would only hide where that has to happen.
	now := time.Now()
	p := &parkedSession{
		sessionID:  s.sessionID,
		uid:        s.d.uid,
		deviceID:   s.deviceID,
		tokenHash:  hashToken(tok),
		generation: gen,
		subs:       subs,
		cursors:    cursors,
		parkedAt:   now,
		expiresAt:  now.Add(resumeLifetime),
	}

	r.mu.Lock()
	defer r.mu.Unlock()
	r.maybeSweepLocked(now)

	// Attach the unacknowledged tail only if the gateway can afford it. Over
	// budget, the session parks without it: resume still restores identity and
	// position, the window refuses, and the client resyncs — today's behaviour,
	// which is the floor this whole feature is allowed to fall back to.
	// An EMPTY window is still parked. nil has to mean "cannot answer for the
	// gap", never "happened to have nothing" — an idle session that parks with
	// nothing outstanding must resume, not resync.
	if window != nil {
		if sz := window.size(); r.replayBytes+sz <= replayParkedBudget {
			p.replay = window
			r.replayBytes += sz
		} else {
			metrics.Inc("ccwire_replay_park_over_budget")
		}
	}

	if len(r.byToken) >= maxParkedSessions {
		// At capacity, drop the oldest rather than grow. Refusing to park the
		// NEWEST would punish the client that just disconnected for the sins of
		// clients that left earlier.
		//
		// Evict a BATCH, not one. Finding the oldest is an O(n) scan, and doing
		// it per park means the scan runs on every disconnect precisely when the
		// table is full — i.e. during the reconnect storm this bound exists to
		// survive. Shedding evictBatch at a time amortises that scan over the
		// next evictBatch parks instead of paying it on each.
		r.evictOldestLocked(evictBatch)
	}
	// Keyed by the HASH, never the token.
	//
	// tokenHash is documented in two places as existing so a memory dump does
	// not yield usable credentials — and the table was then keyed by the
	// plaintext token, which put every live credential in memory in the clear
	// for the whole resume lifetime. The constant-time compare was dead too: a
	// map[string] lookup already proved exact equality, so it could only ever
	// return true. Hashing the key makes the compare the real check it is
	// described as.
	p.missedAtPark = r.missedByUID[p.uid]
	r.parkedByUID[p.uid]++
	r.byToken[string(hashKey(tok))] = p
	metrics.Inc("ccwire_resume_parked")
	return tok, true
}

// take resolves and CONSUMES a token. Single-use: whatever the outcome, the
// presented token is gone afterwards, so a captured token cannot be replayed
// even if the resume it was captured from failed.
func (r *resumeStore) take(token, uid, deviceID string) (*parkedSession, bool) {
	if token == "" || uid == "" {
		return nil, false
	}
	r.mu.Lock()
	defer r.mu.Unlock()

	now := time.Now()
	r.maybeSweepLocked(now)

	p, ok := r.byToken[string(hashKey(token))]
	if !ok {
		metrics.Inc("ccwire_resume_unknown_token")
		return nil, false
	}
	// Consumed regardless of what follows. Detach the window BEFORE dropping,
	// so a successful resume still has it while the budget is already returned.
	// Read the counter BEFORE dropping: dropLocked prunes it when this is the
	// last parked session for the user, which would make every refusal
	// disappear exactly when it is needed.
	missed := r.missedByUID[p.uid]
	replay := p.replay
	r.dropLocked(string(hashKey(token)))
	p.replay = replay

	if now.After(p.expiresAt) {
		metrics.Inc("ccwire_resume_expired")
		return nil, false
	}
	// Constant-time, even though the map lookup already matched: the map is an
	// index, this is the check. Equality here is what stops a token from being
	// accepted for a principal it was never issued to.
	if !equalConstTime(p.tokenHash, hashToken(token)) {
		metrics.Inc("ccwire_resume_token_mismatch")
		return nil, false
	}
	if p.uid != uid {
		// A token from another account. The single most serious thing this
		// function can be asked to do, and it is refused on identity, not on
		// bytes.
		metrics.Inc("ccwire_resume_wrong_user")
		return nil, false
	}
	if p.deviceID != deviceID {
		metrics.Inc("ccwire_resume_wrong_device")
		return nil, false
	}
	if missed != p.missedAtPark {
		// Something was fanned out to this user while this session was parked.
		// The parked session was not in h.cwSessions, so it received nothing
		// and nothing recorded a hole — which means the replay window cannot
		// tell that anything is missing, and would answer "nothing missing".
		// Refusing costs one resync; the alternative is resumed=true with a
		// message silently absent.
		metrics.Inc("ccwire_resume_refused_missed_traffic")
		return nil, false
	}
	return p, true
}

// dropLocked removes a parked session and returns its replay bytes to the
// gateway budget.
//
// Every removal goes through here. Byte accounting spread across take, sweep
// and evict is four places that must agree and no way to tell when they stop —
// the same mistake the replay window's own accounting already had once.
func (r *resumeStore) dropLocked(tok string) {
	p, ok := r.byToken[tok]
	if !ok {
		return
	}
	if p.replay != nil {
		r.replayBytes -= p.replay.size()
		p.replay = nil
	}
	if n := r.parkedByUID[p.uid] - 1; n > 0 {
		r.parkedByUID[p.uid] = n
	} else {
		// Last parked session for this user: the counter has nothing left to
		// shadow, so it goes too. Without this the map grows with every user
		// who has ever parked, which is a slow leak wearing a bound's clothes.
		delete(r.parkedByUID, p.uid)
		delete(r.missedByUID, p.uid)
	}
	delete(r.byToken, tok)
}

// noteTraffic records that something was fanned out to this user.
//
// Called on the delivery path, and deliberately cheap: one map read under a
// mutex, and only when that user actually has a session parked — with nobody
// parked there is nothing to protect and nothing to record.
func (r *resumeStore) noteTraffic(uid string) {
	if r == nil || uid == "" {
		return
	}
	r.mu.Lock()
	if r.parkedByUID[uid] > 0 {
		r.missedByUID[uid]++
	}
	r.mu.Unlock()
}

// forgetUID invalidates every parked session for a user. Called on logout and
// on any security-sensitive change: a resume token must not outlive the
// authority it was issued under.
func (r *resumeStore) forgetUID(uid string) int {
	if uid == "" {
		return 0
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	n := 0
	for tok, p := range r.byToken {
		if p.uid == uid {
			r.dropLocked(tok)
			n++
		}
	}
	if n > 0 {
		metrics.Inc("ccwire_resume_invalidated")
	}
	return n
}

// len reports the parked count. Used by the gauge and by tests.
func (r *resumeStore) len() int {
	r.mu.Lock()
	defer r.mu.Unlock()
	return len(r.byToken)
}

// sweep drops expired entries. Exported for the periodic sweeper.
func (r *resumeStore) sweep(now time.Time) int {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.sweepLocked(now)
}

// maybeSweepLocked runs the full scan at most once per sweepInterval.
//
// Correctness does not depend on it: take() checks expiresAt on the entry it
// resolves, so a not-yet-swept expired session is still refused. The sweep only
// reclaims memory.
func (r *resumeStore) maybeSweepLocked(now time.Time) {
	if now.Sub(r.lastSweep) < sweepInterval {
		return
	}
	r.lastSweep = now
	r.sweepLocked(now)
}

func (r *resumeStore) sweepLocked(now time.Time) int {
	n := 0
	for tok, p := range r.byToken {
		if now.After(p.expiresAt) {
			r.dropLocked(tok)
			n++
		}
	}
	if n > 0 {
		metrics.Inc("ccwire_resume_swept")
	}
	return n
}

// evictOldestLocked sheds up to n of the oldest entries in a single pass.
//
// One pass, n victims: the map is walked once and the n oldest kept in a small
// slice, rather than walking it n times. n is small (evictBatch), so the insert
// is O(len) once per batch rather than O(len) per park.
func (r *resumeStore) evictOldestLocked(n int) {
	if n <= 0 || len(r.byToken) == 0 {
		return
	}
	type victim struct {
		tok string
		at  time.Time
	}
	worst := make([]victim, 0, n)
	for tok, p := range r.byToken {
		if len(worst) < n {
			worst = append(worst, victim{tok, p.parkedAt})
			continue
		}
		// Replace the newest of the currently-held victims if this one is older.
		newest := 0
		for i := 1; i < len(worst); i++ {
			if worst[i].at.After(worst[newest].at) {
				newest = i
			}
		}
		if p.parkedAt.Before(worst[newest].at) {
			worst[newest] = victim{tok, p.parkedAt}
		}
	}
	for _, v := range worst {
		r.dropLocked(v.tok)
		metrics.Inc("ccwire_resume_evicted")
	}
}

// acceptCursors validates client-reported progress against what the server
// actually sent, and returns the positions to restore.
//
// Client progress is a CLAIM. Three ways it can be wrong, and all three are
// refusals rather than adjustments:
//
//   - ahead of what we sent: the client cannot have received what does not
//     exist. Accepting it would let a client skip frames by lying.
//   - behind what we recorded: a cursor must never regress; taking the lower
//     value would re-deliver, and taking it silently would hide a client bug.
//   - naming a stream the session never used: ignored, without failing the
//     whole handshake, because one bad entry is not a reason to force a resync.
func acceptCursors(parked map[uint32]uint64, claimed map[uint32]uint64) (map[uint32]uint64, bool) {
	out := make(map[uint32]uint64, len(parked))
	for k, v := range parked {
		out[k] = v
	}
	for stream, claim := range claimed {
		sent, known := parked[stream]
		if !known {
			metrics.Inc("ccwire_resume_cursor_unknown_stream")
			continue
		}
		if claim > sent {
			metrics.Inc("ccwire_resume_cursor_future")
			return nil, false
		}
		if claim < sent {
			// Not a failure: the client is behind what we sent, which is the
			// normal case after a drop. We keep OUR record, which is the higher
			// one, so the cursor cannot regress.
			metrics.Inc("ccwire_resume_cursor_behind")
			continue
		}
		out[stream] = claim
	}
	return out, true
}

// supersedes reports whether gen may advance state for this parked session.
//
// The race this exists for: connection A is alive but unreachable, B resumes and
// takes generation N+1, then A's queued frames finally arrive. A must not be
// able to move cursors, presence, receipts or delivery state — it is describing
// a world that has moved on.
func (p *parkedSession) supersedes(gen uint64) bool {
	return gen >= p.generation
}

// ── session integration ─────────────────────────────────────────────

// tryResume attempts to restore a parked session from the client's offer.
//
// It NEVER fails the handshake. Every refusal simply leaves s.resumed false, so
// the ServerHello says resumed=false and the client does what it does today.
// That is deliberate: a resume that cannot be completed must cost the client a
// resync, not a connection.
func (s *ccwireSession) tryResume(h clientHello) {
	if s.hub == nil || s.hub.resume == nil || s.d == nil {
		return
	}
	metrics.Inc("ccwire_resume_attempt")

	// take() consumes the token whatever happens next, so a token that fails
	// here cannot be retried against a different principal.
	p, ok := s.hub.resume.take(h.resumeToken, s.d.uid, s.deviceID)
	if !ok {
		metrics.Inc("ccwire_resume_refused")
		return
	}

	// The client's claimed progress is checked against what the server actually
	// sent. A future cursor refuses the whole resume: a client cannot have
	// received what does not exist, and accepting the claim would let it skip
	// frames by lying.
	cursors, ok := acceptCursors(p.cursors, h.resumeFrom)
	if !ok {
		metrics.Inc("ccwire_resume_refused_cursor")
		return
	}

	// What the client is missing, in full or not at all. A window that cannot
	// cover the gap refuses the WHOLE resume rather than replaying part of it:
	// a resumed=true with a hole in the stream is silent message loss wearing
	// the costume of a successful resume, and is the one outcome this design
	// exists to make impossible.
	// A nil window (parked over budget, or a gateway that had none) answers
	// false here exactly as a holed one does. resumed=true has to mean "you
	// have everything up to your cursor and the rest is on its way"; anything
	// weaker is the silent hole in a different costume.
	// Replay from what the CLIENT says it has, not from what we recorded.
	//
	// These are two different numbers and conflating them loses messages.
	// acceptCursors deliberately keeps OUR higher value when the client is
	// behind, because a delivery cursor must not regress. Replaying from that
	// higher value would skip exactly the frames the client just told us it is
	// missing — the silent hole, arrived at by way of a correct rule applied to
	// the wrong question.
	//
	// Streams the client did not mention are left OUT rather than defaulted.
	// since() then refuses if anything is retained for them, because "the
	// client said nothing about this stream" is not the same as "the client has
	// everything on it".
	replayFrom := make(map[uint32]uint64, len(h.resumeFrom))
	for stream := range cursors {
		if claim, told := h.resumeFrom[stream]; told {
			replayFrom[stream] = claim
		}
	}

	// `cursors` is the authority for which streams this session sent on, so it
	// is what since() checks the client's report against. Passing only the
	// client's own map would let silence about a stream read as completeness.
	missed, ok := p.replay.since(replayFrom, cursors)
	if !ok {
		metrics.Inc("ccwire_resume_refused_replay")
		return
	}
	s.replay = p.replay

	s.sessionID = p.sessionID
	s.cursors = cursors
	// Keep counting from where the parked connection stopped.
	//
	// Restarting at 1 is not cosmetic. noteSent is monotonic, so every frame
	// after the resume would sit below the restored cursor and move nothing:
	// the cursor freezes at its parked value for the life of the session, the
	// client's position becomes unreachable, the window never releases, and the
	// next resume refuses. Resume would work exactly once per client.
	s.pos.next = make(map[uint32]uint64, len(cursors))
	for stream, at := range cursors {
		s.pos.next[stream] = at
	}
	s.pendingReplay = missed
	s.generation = p.generation + 1 // supersede the connection that parked this
	if s.subs == nil {
		s.subs = map[string]struct{}{}
	}
	for _, sub := range p.subs {
		s.subs[sub] = struct{}{}
	}
	s.resumed = true
	metrics.Inc("ccwire_resume_ok")
}

// parkForResume is called as a session goes away, so the next connection can
// pick it up. Returns the token, or "" when resume is not on offer.
//
// A failure to park is silent and harmless: the client reconnects fresh, which
// is the behaviour that exists today.
func (s *ccwireSession) parkForResume() string {
	if s == nil || s.hub == nil || s.hub.resume == nil {
		return ""
	}
	// Snapshot and HAND OVER, under the lock, in one step.
	//
	// The window must stop being reachable from the session here. A fan-out
	// that snapshotted its target list just before this session unregistered
	// can still call deliver() afterwards; enqueue() drops the frame because
	// the session is closed, but retain() would already have mutated a window
	// the store now owns and has charged to its byte budget. Nilling it means
	// that late deliver takes the shared path and touches nothing.
	s.pos.mu.Lock()
	cursors := make(map[uint32]uint64, len(s.cursors))
	for k, v := range s.cursors {
		cursors[k] = v
	}
	gen := s.generation
	window := s.replay
	s.replay = nil
	s.pos.mu.Unlock()

	// Subscriptions have their own lock and their own writers (join/leave).
	s.subMu.RLock()
	subs := make([]string, 0, len(s.subs))
	for sub := range s.subs {
		subs = append(subs, sub)
	}
	s.subMu.RUnlock()

	tok, ok := s.hub.resume.park(s, cursors, subs, window, gen)
	if !ok {
		return ""
	}
	return tok
}

// helloWantsResumption reports whether ClientHello negotiated
// Capabilities.resumption (capabilities = field 3, resumption = field 2).
//
// Deliberately a separate reader rather than an extra return from
// helloAppEvents: that function has one job and a second boolean threaded
// through it would make both harder to reason about. The cost is one more pass
// over a handful of bytes at handshake time, once per connection.
func helloWantsResumption(body []byte, lim ccwire.Limits) bool {
	r := pbr{b: body}
	for r.p < len(r.b) {
		t, ok := r.tag()
		if !ok {
			return false
		}
		if t>>3 == 3 && t&7 == 2 { // capabilities
			b, ok := r.span(lim.MaxStringFieldBytes)
			if !ok {
				return false
			}
			c := pbr{b: b}
			for c.p < len(c.b) {
				ct, ok := c.tag()
				if !ok {
					return false
				}
				if ct>>3 == 2 && ct&7 == 0 { // resumption
					v, ok := c.varint()
					return ok && v != 0
				}
				if !c.skip(uint8(ct&7), lim) {
					return false
				}
			}
			return false
		}
		if !r.skip(uint8(t&7), lim) {
			return false
		}
	}
	return false
}

// InvalidateResume drops every parked session for a user.
//
// Called when the authority a resume token was issued under goes away: logout,
// password change, device unlink, session revocation. A resume token must never
// outlive that authority — otherwise "log out everywhere" leaves a credential
// behind that silently restores a session.
//
// Safe on a nil hub and a nil store so callers do not need to know whether
// CC-Wire is running: a server without realtime has nothing to invalidate, and
// that is not an error.
func (h *Hub) InvalidateResume(uid string) int {
	if h == nil || h.resume == nil {
		return 0
	}
	// LIVE FIRST, then parked. The other order leaves a gap: forgetUID
	// completes, a session drops and parks under its pre-revocation token, and
	// revokeLiveResume then clears a field on a session that has already handed
	// that token to the store — so the parked entry survives the invalidation
	// for its whole lifetime. Clearing the live tokens first means anything
	// that parks afterwards has no token to park with, and park() refuses.
	n := h.revokeLiveResume(uid)
	return n + h.resume.forgetUID(uid)
}

// revokeLiveResume takes the resume credential away from this user's LIVE
// sessions.
//
// forgetUID only walks the PARKED table, and a live session's token is not in
// it — the token is minted at ServerHello and only reaches the store when the
// session parks. So revocation used to be a no-op against exactly the sessions
// that are still running: log out, stay connected, drop later, and the
// connection parks under the credential the logout was supposed to destroy,
// resumable for the whole resume lifetime.
//
// Clearing the token is enough on its own: park() refuses a session with no
// token, so the session simply cannot be parked. The socket is left alone —
// tearing down a live connection is the access layer's decision, not this
// one's, and the upgrade is re-authenticated by httpx.RequireAuth anyway.
func (h *Hub) revokeLiveResume(uid string) int {
	h.cwmu.Lock()
	live := make([]*ccwireSession, 0, len(h.cwSessions[uid]))
	for s := range h.cwSessions[uid] {
		live = append(live, s)
	}
	h.cwmu.Unlock()

	n := 0
	for _, s := range live {
		s.pos.mu.Lock()
		had := s.resumeToken != ""
		s.resumeToken = ""
		s.replay = nil // nothing left to replay into
		s.pos.mu.Unlock()
		if had {
			n++
		}
	}
	if n > 0 {
		metrics.Inc("ccwire_resume_revoked_live")
	}
	return n
}

// InvalidateResumeFor is the package-level form for callers that only have the
// default hub — routes packages that must not import a Hub handle.
func InvalidateResumeFor(uid string) int {
	return Default.InvalidateResume(uid)
}

// startResumeSweep releases expired parked sessions on a timer.
//
// park() and take() sweep opportunistically, but a gateway that goes quiet has
// neither: without this, sessions parked just before a lull are held until the
// next reconnect. Bounded work — one map walk per interval — and it is the
// difference between "bounded by expiry" and "bounded by expiry, eventually".
func (h *Hub) startResumeSweep() {
	if h == nil || h.resume == nil {
		return
	}
	go func() {
		t := time.NewTicker(resumeSweepInterval)
		defer t.Stop()
		for range t.C {
			h.resume.sweep(time.Now())
		}
	}()
}

// noteProgress reads Ping.progress (repeated StreamCursor, field 2) and records
// what the client says it has received.
//
// # WHY THIS MATTERS FOR RESUME
//
// s.cursors records what the server SENT. That is the right authority for
// refusing a lying claim, but it is the wrong starting point for a replay: after
// an ungraceful drop the last few sent frames were exactly the ones that did not
// arrive. Progress is the client telling us where it actually got to.
//
// # THE SAFETY RULE
//
// A client's claim can only ever move its acked position FORWARD and never past
// what we sent. Both bounds matter:
//
//   - past what we sent: the client cannot have received what does not exist.
//     Honouring it would let a client skip frames by lying.
//   - backwards: cursors do not regress. A lower claim is stale or reordered,
//     and taking it would re-deliver.
func (s *ccwireSession) noteProgress(body []byte) {
	if len(body) == 0 {
		return
	}
	r := pbr{b: body}
	seen := 0
	for r.p < len(r.b) {
		tag, ok := r.tag()
		if !ok || tag>>3 == 0 {
			return
		}
		field, wire := uint32(tag>>3), uint8(tag&7)
		if field == 2 && wire == 2 { // progress
			b, ok := r.span(s.lim.MaxStringFieldBytes)
			if !ok {
				return
			}
			// Same bound resume_from uses: there are five streams, so anything
			// past this is malformed or hostile either way.
			if seen >= maxResumeFromEntries {
				return
			}
			seen++
			stream, seq, ok := parseStreamCursor(b, s.lim)
			if !ok {
				return
			}
			s.noteAcked(stream, seq)
			continue
		}
		if !r.skip(wire, s.lim) {
			return
		}
	}
}

// noteAcked records a client-claimed position, clamped to reality.
func (s *ccwireSession) noteAcked(stream uint32, seq uint64) {
	s.pos.mu.Lock()
	defer s.pos.mu.Unlock()
	s.noteAckedLocked(stream, seq)
}

func (s *ccwireSession) noteAckedLocked(stream uint32, seq uint64) {
	sent, known := s.cursors[stream]
	if !known {
		// A stream this session never sent on. Ignored rather than treated as a
		// protocol error: one odd entry is not worth dropping a live connection.
		metrics.Inc("ccwire_progress_unknown_stream")
		return
	}
	if seq > sent {
		metrics.Inc("ccwire_progress_future")
		return
	}
	if s.acked == nil {
		s.acked = map[uint32]uint64{}
	}
	if seq > s.acked[stream] {
		s.acked[stream] = seq
		// The client has these; holding them is pure cost. This is what keeps a
		// healthy connection's window near empty, so the bounds are sized for
		// the unhealthy case rather than the normal one.
		s.replay.release(stream, seq)
	}
}

// NOTE: resumePosition (park the ACKED position) was removed when the replay
// window was wired in. It answered a question that no longer exists.
//
// Parking `acked` made sense while the parked cursor WAS the resume-from point:
// parking `sent` would have told the next connection the client already had
// frames that never arrived. Replay changed which number does that job. The
// resume-from point now comes from the client's own `resume_from` claim, and
// the parked cursor is the UPPER BOUND that claim is checked against — "you
// cannot have received what I never sent". An acked high-water is the wrong
// bound for that: a client that received all four frames and lost only the ack
// would have its honest claim of 4 refused as a future cursor, turning the most
// ordinary drop into a forced resync.
