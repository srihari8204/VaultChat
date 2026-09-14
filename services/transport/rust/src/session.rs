//! Session lifecycle: handshake, resume, heartbeat, reconnect backoff.
//!
//! PURE. No I/O, no async, no clock of its own: every function that needs the
//! time takes `now_ms: u64` from the caller. That is what lets "does a dead
//! connection get noticed in 15 seconds" be a unit test instead of a soak run.
//!
//! CONTRACT (proto/ccwire/v1/capabilities.proto):
//!   heartbeat_interval_ms = 10000, heartbeat_timeout_ms = 5000
//!   resumption is a NEGOTIATED capability; absent on either side ⇒ no resume
//!   capabilities negotiate by INTERSECTION, never union
//!   an unknown capability is INERT — echoed back, never activated
//!
//! WHAT MUST NOT HAPPEN:
//!   * A failed resume must surface as "full resync required", never as a
//!     silent success. ServerHello.resumed = false is a COMMAND to the client.
//!   * Backoff must be jittered. Unjittered backoff turns one server blip into
//!     a synchronised stampede from every client at once.
//!   * ERROR_CLASS_AUTH must NOT be retried on the backoff path — it needs
//!     ReAuth. Retrying an expired credential forever is how a client
//!     hammers a server it can never satisfy.
//!   * A resume token is a CREDENTIAL. It must never be logged, and clearing
//!     the session must clear it.
//!
//! This module decides; it never acts. `poll` says "send a ping", it does not
//! send one — same rule `sched` follows, and the reason both are testable.

use crate::parse::Limits;

/// `Limits.heartbeat_interval_ms` from capabilities.proto. Silence longer than
/// this is not yet a failure — it is the cue to prove the path is alive.
pub const HEARTBEAT_INTERVAL_MS: u64 = 10_000;

/// `Limits.heartbeat_timeout_ms`. A ping unanswered this long means dead, not
/// slow: the whole point of a liveness probe is that waiting forever for the
/// answer is the failure mode it exists to end.
pub const HEARTBEAT_TIMEOUT_MS: u64 = 5_000;

/// First reconnect delay. Short enough that a one-second blip is invisible to
/// the user, long enough that a flapping server is not re-hammered instantly.
pub const BACKOFF_BASE_MS: u64 = 500;

/// Ceiling on the backoff. Unbounded doubling means a client that missed one
/// outage sleeps through the next hour of uptime.
pub const BACKOFF_MAX_MS: u64 = 30_000;

/// Doublings before the cap binds: 500 << 6 = 32000 > BACKOFF_MAX_MS. Capping
/// the SHIFT and not just the result keeps the shift itself in range — an
/// overflowing `<<` panics in debug and this crate builds with
/// `overflow-checks` on in release too.
const BACKOFF_SHIFT_MAX: u32 = 6;

/// Handshake lifecycle. The only legal edges are:
///   Idle → Connecting → Handshaking → Ready → Draining → Closed
/// plus `close()` from anywhere, and `on_disconnect` back to Idle.
///
/// Every other edge is REFUSED, not ignored. A silently-dropped transition is
/// how a client ends up believing it is Ready on a socket that never finished
/// a handshake, and then sends application frames to a peer that has agreed to
/// nothing.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum State {
    Idle,
    Connecting,
    Handshaking,
    Ready,
    Draining,
    Closed,
}

/// Why a session operation was refused. A value, never a string — the caller
/// decides between re-authenticating and giving up, and that decision must not
/// depend on parsing prose.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SessionError {
    /// An edge the machine does not have.
    IllegalTransition { from: State, to: State },
    /// Resume was offered with no token, or without `resumption` negotiated.
    ResumeUnavailable,
}

/// `ErrorClass` from proto/ccwire/v1/errors.proto.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ErrorClass {
    Unspecified = 0,
    Retryable = 1,
    Fatal = 2,
    /// The client should ReAuth, not retry.
    Auth = 3,
}

/// What the host should do after the connection went away.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Recovery {
    /// Reconnect at this ABSOLUTE instant. Absolute, not a duration, so the
    /// host cannot accidentally restart the delay on every wakeup.
    Retry { at_ms: u64 },
    /// ERROR_CLASS_AUTH. The credential is the problem; no number of retries
    /// can satisfy a server that has already said the token is expired.
    ReAuth,
    /// Fatal, or a class this build does not recognise. No automatic recovery.
    Stop,
}

/// What the heartbeat wants from the host at `now_ms`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Beat {
    /// Nothing due.
    Idle,
    /// Silence has reached the interval — prove the path.
    SendPing,
    /// A ping went unanswered past the timeout. REPORTED, not acted on: this
    /// module does not tear down the connection, the host does.
    Dead,
}

/// A resume credential.
///
/// `Debug` is hand-written to redact. `#[derive(Debug)]` here would put the
/// token into every log line that ever formats a `Session`, a `ServerHello`,
/// or any future struct that happens to hold one — which is why the redaction
/// lives on the credential itself rather than on each holder: a holder can
/// forget, the newtype cannot.
#[derive(Clone, PartialEq, Eq)]
pub struct ResumeToken(String);

impl ResumeToken {
    pub fn new(s: impl Into<String>) -> Self {
        ResumeToken(s.into())
    }

    /// Named to make the call site read as a deliberate act at review time.
    pub fn expose(&self) -> &str {
        &self.0
    }
}

impl core::fmt::Debug for ResumeToken {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        f.write_str("ResumeToken(<redacted>)")
    }
}

/// `Capabilities` from capabilities.proto.
///
/// There is deliberately no `legacy_crypto`, no `plaintext_fallback` and no
/// `skip_verification`, and none may be added: a transport negotiation is not
/// an authorization to downgrade.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Capabilities {
    pub fragmentation: bool,
    pub resumption: bool,
    pub batch_cursor_sync: bool,
    pub datagrams: bool,
    pub reauth_in_place: bool,
    pub causal_epochs: bool,
    pub structured_errors: bool,
    /// Capabilities this build cannot name. Carried, never consulted.
    pub experimental: Vec<String>,
}

impl Capabilities {
    /// Everything this build knows how to do.
    pub fn all() -> Self {
        Capabilities {
            fragmentation: true,
            resumption: true,
            batch_cursor_sync: true,
            datagrams: true,
            reauth_in_place: true,
            causal_epochs: true,
            structured_errors: true,
            experimental: Vec::new(),
        }
    }

    /// INTERSECTION, never union. A capability one side cannot perform is not
    /// made available by the other side offering it — union would mean the peer
    /// decides what code runs here.
    pub fn intersect(&self, peer: &Capabilities) -> Capabilities {
        Capabilities {
            fragmentation: self.fragmentation && peer.fragmentation,
            resumption: self.resumption && peer.resumption,
            batch_cursor_sync: self.batch_cursor_sync && peer.batch_cursor_sync,
            datagrams: self.datagrams && peer.datagrams,
            reauth_in_place: self.reauth_in_place && peer.reauth_in_place,
            causal_epochs: self.causal_epochs && peer.causal_epochs,
            structured_errors: self.structured_errors && peer.structured_errors,
            // INERT. The peer's unknown names are echoed back unmodified and no
            // boolean above is ever derived from them — a capability this build
            // cannot name is one it cannot implement, so carrying the string is
            // the only safe thing to do with it.
            experimental: peer.experimental.clone(),
        }
    }
}

/// The server's half of the handshake.
#[derive(Debug, Clone)]
pub struct ServerHello {
    pub capabilities: Capabilities,
    /// The SERVER's limits. They bind; see `Limits::tighten` in `parse`.
    pub limits: Limits,
    pub heartbeat_interval_ms: u64,
    pub heartbeat_timeout_ms: u64,
    /// A COMMAND, not a hint. `false` means the client must full-resync.
    pub resumed: bool,
    pub resume_token: Option<ResumeToken>,
}

/// The outcome of a handshake, for the host to act on.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Accepted {
    /// The server kept our stream position. Continue where we left off.
    Resumed,
    /// FULL RESYNC REQUIRED. Returned whenever resumption did not demonstrably
    /// succeed, so "it silently half-resumed" is not a reachable state.
    FullResync,
}

/// A peer may propose a SMALLER bound and never a larger one. Zero means "not
/// proposed", never "unlimited" — the same rule and the same zero-value
/// convention as `parse::Limits::tighten`.
fn tighten_ms(cur: u64, proposed: u64) -> u64 {
    if proposed > 0 && proposed < cur { proposed } else { cur }
}

/// splitmix64. A named, fixed, inline mixer rather than a random source: the
/// entropy comes from the CALLER's seed, so a test can pin the exact instant a
/// given client wakes up. A PRNG this module seeded itself would make the
/// stampede test unwritable.
fn mix(mut z: u64) -> u64 {
    z = z.wrapping_add(0x9e37_79b9_7f4a_7c15);
    z = (z ^ (z >> 30)).wrapping_mul(0xbf58_476d_1ce4_e5b9);
    z = (z ^ (z >> 27)).wrapping_mul(0x94d0_49bb_1331_11eb);
    z ^ (z >> 31)
}

/// Exponential backoff with EQUAL JITTER, capped.
///
/// Half the window is fixed and half is random. Full jitter (uniform over the
/// whole window) also breaks the stampede but throws away the floor, so a
/// client can retry after 3ms on its tenth attempt; keeping the fixed half
/// means the delay still genuinely grows. The random half is what stops ten
/// thousand clients that were disconnected by the same blip from returning in
/// the same millisecond and causing the second outage themselves.
pub fn backoff_delay_ms(attempt: u32, seed: u64) -> u64 {
    let window = (BACKOFF_BASE_MS << attempt.min(BACKOFF_SHIFT_MAX)).min(BACKOFF_MAX_MS);
    let half = window / 2;
    // `attempt` is mixed in so consecutive attempts by one client are not the
    // same draw — otherwise a client's jitter is a constant offset and the
    // cohort stays in lockstep, merely shifted.
    half + mix(seed ^ (attempt as u64).wrapping_mul(0x517c_c1b7_2722_0a95)) % (half + 1)
}

/// One connection's session state.
///
/// `Debug` is derived deliberately: the only credential it holds is a
/// `ResumeToken`, which redacts itself.
#[derive(Debug)]
pub struct Session {
    state: State,
    /// Caller-supplied entropy for jitter. Fixed for the life of the session so
    /// a host can reproduce a client's wake-up schedule from a log.
    seed: u64,
    local: Capabilities,
    negotiated: Option<Capabilities>,
    limits: Limits,
    hb_interval_ms: u64,
    hb_timeout_ms: u64,
    token: Option<ResumeToken>,
    /// Whether the client actually presented a token on THIS handshake. Without
    /// it, `resumed = true` from the server is unverifiable.
    offered_resume: bool,
    attempt: u32,
    last_rx_ms: u64,
    ping_sent_ms: Option<u64>,
}

impl Session {
    pub fn new(local: Capabilities, seed: u64) -> Self {
        Session {
            state: State::Idle,
            seed,
            local,
            negotiated: None,
            limits: Limits::default(),
            hb_interval_ms: HEARTBEAT_INTERVAL_MS,
            hb_timeout_ms: HEARTBEAT_TIMEOUT_MS,
            attempt: 0,
            token: None,
            offered_resume: false,
            last_rx_ms: 0,
            ping_sent_ms: None,
        }
    }

    pub fn state(&self) -> State {
        self.state
    }

    /// The intersection, once the handshake has produced one. `None` before
    /// that — NOT an empty set, because "nothing negotiated yet" and
    /// "negotiated to nothing" must not be confused by the caller.
    pub fn negotiated(&self) -> Option<&Capabilities> {
        self.negotiated.as_ref()
    }

    pub fn limits(&self) -> &Limits {
        &self.limits
    }

    pub fn heartbeat_interval_ms(&self) -> u64 {
        self.hb_interval_ms
    }

    pub fn heartbeat_timeout_ms(&self) -> u64 {
        self.hb_timeout_ms
    }

    pub fn attempt(&self) -> u32 {
        self.attempt
    }

    /// True only if a token is held AND `resumption` survived the intersection.
    pub fn can_resume(&self) -> bool {
        self.token.is_some() && self.negotiated.as_ref().is_some_and(|c| c.resumption)
    }

    fn edge(&mut self, from: State, to: State) -> Result<(), SessionError> {
        if self.state != from {
            return Err(SessionError::IllegalTransition { from: self.state, to });
        }
        self.state = to;
        Ok(())
    }

    /// Idle → Connecting. Refused from anywhere else, including Ready: a second
    /// connect on a live session would leave two sockets and one state machine.
    pub fn connect(&mut self) -> Result<(), SessionError> {
        self.edge(State::Idle, State::Connecting)
    }

    /// Connecting → Handshaking. `offer_resume` is the client presenting its
    /// token; refused if there is nothing to present, so an impossible resume
    /// fails here rather than being discovered as a fake success later.
    pub fn send_client_hello(&mut self, offer_resume: bool) -> Result<(), SessionError> {
        if offer_resume && self.token.is_none() {
            return Err(SessionError::ResumeUnavailable);
        }
        self.edge(State::Connecting, State::Handshaking)?;
        self.offered_resume = offer_resume;
        Ok(())
    }

    /// Handshaking → Ready. Negotiates capabilities and limits, and returns
    /// whether the stream resumed or must be resynced from scratch.
    ///
    /// The return value is the ONLY way to learn the answer — there is no
    /// `is_resumed()` getter to forget to call, and `Accepted` is
    /// `#[must_use]` by virtue of being inside a `Result`.
    pub fn on_server_hello(
        &mut self,
        hello: ServerHello,
        now_ms: u64,
    ) -> Result<Accepted, SessionError> {
        self.edge(State::Handshaking, State::Ready)?;

        let neg = self.local.intersect(&hello.capabilities);

        // The SERVER's values bind and may only TIGHTEN ours. A peer proposing
        // a LARGER bound than this build compiled with does not get it —
        // negotiation is not authority.
        self.limits = self.limits.tighten(&hello.limits);
        self.hb_interval_ms = tighten_ms(self.hb_interval_ms, hello.heartbeat_interval_ms);
        self.hb_timeout_ms = tighten_ms(self.hb_timeout_ms, hello.heartbeat_timeout_ms);

        // A resume counts ONLY if the server said so, we actually offered a
        // token, and `resumption` survived the intersection. Any weaker test
        // lets "resumed" be true on a stream nobody preserved, which is the
        // silent-success failure this module exists to prevent. Ambiguity in
        // the spec is resolved toward FullResync: a needless resync costs
        // bandwidth, a missed one costs messages.
        let resumed = hello.resumed && self.offered_resume && neg.resumption;
        self.offered_resume = false;
        self.negotiated = Some(neg);
        self.attempt = 0;
        self.last_rx_ms = now_ms;
        self.ping_sent_ms = None;

        if !resumed {
            // ServerHello.resumed = false is a COMMAND. The old token named a
            // stream position the server has already discarded; keeping it
            // would make the NEXT reconnect offer a credential for a session
            // that no longer exists.
            self.token = None;
        }
        // A token issued now supersedes whatever we held, resumed or not.
        if let Some(t) = hello.resume_token {
            self.token = Some(t);
        }

        Ok(if resumed { Accepted::Resumed } else { Accepted::FullResync })
    }

    /// Ready → Draining. The connection still carries traffic and is still
    /// heartbeat-supervised; it just accepts no new work.
    pub fn drain(&mut self) -> Result<(), SessionError> {
        self.edge(State::Ready, State::Draining)
    }

    /// The one edge legal from every state, including Closed (idempotent): a
    /// shutdown that can be refused is a shutdown that leaks a connection.
    pub fn close(&mut self) {
        self.state = State::Closed;
        self.clear();
    }

    /// Drop every negotiated result and the credential.
    ///
    /// Clearing the session clears the token — a resume credential that
    /// outlives the session it belongs to is a credential nothing is watching.
    pub fn clear(&mut self) {
        self.token = None;
        self.negotiated = None;
        self.offered_resume = false;
        self.ping_sent_ms = None;
    }

    /// Anything received from the peer proves liveness — a ping is only needed
    /// because nothing else arrived, so real traffic must reset the same timer
    /// or a busy connection pings for no reason.
    pub fn on_traffic(&mut self, now_ms: u64) {
        if now_ms > self.last_rx_ms {
            self.last_rx_ms = now_ms;
        }
        self.ping_sent_ms = None;
    }

    /// What the host should do about liveness at `now_ms`.
    ///
    /// Only a connection that is up is supervised: polling an Idle or Closed
    /// session cannot report Dead, because a session that was never connected
    /// has not failed.
    pub fn poll(&mut self, now_ms: u64) -> Beat {
        if !matches!(self.state, State::Ready | State::Draining) {
            return Beat::Idle;
        }
        if let Some(sent) = self.ping_sent_ms {
            // `>=` and not `>`: the timeout is the deadline, not the first
            // instant after it. 10000 + 5000 means dead AT 15000.
            return if now_ms >= sent.saturating_add(self.hb_timeout_ms) {
                Beat::Dead
            } else {
                Beat::Idle
            };
        }
        if now_ms >= self.last_rx_ms.saturating_add(self.hb_interval_ms) {
            self.ping_sent_ms = Some(now_ms);
            return Beat::SendPing;
        }
        Beat::Idle
    }

    /// The connection went away. Returns what to do about it.
    ///
    /// AUTH NEVER REACHES THE BACKOFF PATH. An expired or invalid credential is
    /// not a transient condition, and a client that retries one on a growing
    /// timer is a client that hammers a server which can never satisfy it —
    /// forever, since nothing about waiting renews a token.
    pub fn on_disconnect(&mut self, class: ErrorClass, now_ms: u64) -> Recovery {
        self.ping_sent_ms = None;
        match class {
            ErrorClass::Retryable => {
                let delay = backoff_delay_ms(self.attempt, self.seed);
                self.attempt = self.attempt.saturating_add(1);
                self.negotiated = None;
                self.offered_resume = false;
                // Back to Idle, not Closed: the token survives so the next
                // handshake can offer it.
                self.state = State::Idle;
                Recovery::Retry { at_ms: now_ms.saturating_add(delay) }
            }
            ErrorClass::Auth => {
                // The token is authenticated state. Whatever rejected the
                // credential invalidates it too, so it goes now rather than
                // being offered again after a ReAuth that replaced it.
                self.state = State::Closed;
                self.clear();
                Recovery::ReAuth
            }
            // Fatal is Stop by definition. Unspecified is Stop by CHOICE: a
            // class this build cannot name is one whose retry-safety it cannot
            // establish, and guessing "retryable" is the guess that hammers.
            ErrorClass::Fatal | ErrorClass::Unspecified => {
                self.state = State::Closed;
                self.clear();
                Recovery::Stop
            }
        }
    }
}
