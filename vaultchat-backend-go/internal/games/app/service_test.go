package app

import (
	"context"
	"errors"
	"testing"
	"time"

	"vaultchat/backend-go/internal/games/domain"
)

// Fakes for the ports: the use cases run with no database, FCM or keys.

type fakeMatches struct {
	stored  domain.Match
	loseWin bool // the next Advance loses the race to another seat
	winner  domain.Match
}

func (f *fakeMatches) Open(context.Context, string, domain.Variant, string) (domain.Match, error) {
	return f.stored, nil
}
func (f *fakeMatches) Running(context.Context, string) (*domain.Match, error) { return nil, nil }
func (f *fakeMatches) Get(context.Context, string) (domain.Match, error)      { return f.stored, nil }
func (f *fakeMatches) Advance(_ context.Context, next domain.Match, from int) (bool, error) {
	if f.loseWin || from != f.stored.DealsPlayed {
		f.stored = f.winner
		return false, nil
	}
	f.stored = next
	return true, nil
}

type fakePlayers struct{ vaultID string }

func (p fakePlayers) Player(context.Context, string) (domain.Player, error) {
	return domain.Player{VaultID: p.vaultID}, nil
}
func (p fakePlayers) VaultID(context.Context, string) (string, error) { return p.vaultID, nil }
func (p fakePlayers) UserIDForVault(context.Context, string) (string, error) {
	return "user-1", nil
}

func running() domain.Match {
	return domain.Match{ID: "m1", TableID: "t1", Variant: domain.Pool101, Status: domain.MatchRunning,
		Scores: map[string]domain.Score{}}
}

var deal = []domain.DealResult{{VaultID: "a", Points: 0, Winner: true}, {VaultID: "b", Points: 120}}

func TestAdvanceAppliesOnceAndFinishes(t *testing.T) {
	m := &fakeMatches{stored: running()}
	s := &Service{Players: fakePlayers{"a"}, Matches: m}
	got, err := s.AdvanceMatch(context.Background(), "u", "m1", 0, deal)
	if err != nil {
		t.Fatal(err)
	}
	if got.DealsPlayed != 1 || got.Status != domain.MatchFinished || got.Scores["b"].Status != domain.StatusOut {
		t.Fatalf("one deal at 120 must eliminate b and end the pool, got %+v", got)
	}
	// The same deal reported by another seat changes nothing.
	again, err := s.AdvanceMatch(context.Background(), "u", "m1", 0, deal)
	if err != nil || again.DealsPlayed != 1 {
		t.Fatalf("a duplicate report must be a no-op, got %+v err=%v", again, err)
	}
}

// Losing the write race returns what the winner wrote, not our computation.
func TestAdvanceLostRaceReturnsTheWinner(t *testing.T) {
	winner := running()
	winner.DealsPlayed = 1
	winner.Scores = map[string]domain.Score{"a": {Name: "winner", Status: domain.StatusPlaying}}
	m := &fakeMatches{stored: running(), loseWin: true, winner: winner}
	got, err := (&Service{Players: fakePlayers{"a"}, Matches: m}).AdvanceMatch(context.Background(), "u", "m1", 0, deal)
	if err != nil || got.Scores["a"].Name != "winner" {
		t.Fatalf("want the winner's state, got %+v err=%v", got, err)
	}
}

func TestAdvanceNeedsAVaultID(t *testing.T) {
	_, err := (&Service{Players: fakePlayers{""}, Matches: &fakeMatches{}}).AdvanceMatch(context.Background(), "u", "m1", 0, deal)
	if !errors.Is(err, ErrNoVaultID) {
		t.Fatalf("want ErrNoVaultID, got %v", err)
	}
}

type fakeVerifier struct{ ev domain.Event }

func (fakeVerifier) Ready() error                          { return nil }
func (v fakeVerifier) Verify(string) (domain.Event, error) { return v.ev, nil }

type fakeDedupe struct{ seen map[string]bool }

func (d *fakeDedupe) Claim(_ context.Context, jti string, _ time.Time) (bool, error) {
	if d.seen[jti] {
		return false, nil
	}
	d.seen[jti] = true
	return true, nil
}
func (d *fakeDedupe) Release(_ context.Context, jti string) { delete(d.seen, jti) }

type fakeTables struct{ remembered []domain.LiveTable }

func (f *fakeTables) List(context.Context, string) ([]domain.LiveTable, error) { return nil, nil }
func (f *fakeTables) Remember(_ context.Context, _ string, t domain.LiveTable) error {
	f.remembered = append(f.remembered, t)
	return nil
}
func (f *fakeTables) Forget(context.Context, string, string, string) error { return nil }

type fakePush struct {
	ok      bool
	sent    map[string]string
	cleared []string
}

func (p *fakePush) Tokens(context.Context, string) []string                { return []string{"live", "dead"} }
func (p *fakePush) Register(context.Context, string, string, string) error { return nil }
func (p *fakePush) Unregister(context.Context, string, string) error       { return nil }
func (p *fakePush) ClearDead(_ context.Context, t []string)                { p.cleared = t }
func (p *fakePush) Send(_ []string, data map[string]string, ttl time.Duration) PushResult {
	p.sent = data
	if !p.ok {
		return PushResult{Dead: []string{"dead"}}
	}
	return PushResult{OK: true, Sent: 1, Dead: []string{"dead"}}
}

func notifySvc(ok bool, kind string) (*Service, *fakeDedupe, *fakeTables, *fakePush) {
	d, tb, p := &fakeDedupe{seen: map[string]bool{}}, &fakeTables{}, &fakePush{ok: ok}
	return &Service{
		Players:  fakePlayers{"v"},
		Verifier: fakeVerifier{domain.Event{Recipient: "v", ID: "j1", Kind: kind, Title: " Your turn ", Game: "rummy", Room: "t-1"}},
		Dedupe:   d, Tables: tb, Devices: p, Pusher: p, Now: time.Now,
	}, d, tb, p
}

func TestNotifyDeliversAndClearsDeadTokens(t *testing.T) {
	s, _, tb, p := notifySvc(true, "turn")
	res, err := s.Notify(context.Background(), "event")
	if err != nil || !res.Delivered || res.Sent != 1 {
		t.Fatalf("got %+v err=%v", res, err)
	}
	if p.sent["type"] != "games_turn" || p.sent["game"] != "rummy" || p.sent["room"] != "t-1" || p.sent["title"] != "Your turn" {
		t.Fatalf("push payload %v", p.sent)
	}
	if len(p.cleared) != 1 || len(tb.remembered) != 1 || !tb.remembered[0].YourTurn {
		t.Fatalf("dead tokens %v, remembered %+v", p.cleared, tb.remembered)
	}
}

// A failed push releases the jti, so the games server's retry is not deduped
// into silence.
func TestNotifyFailedPushReleasesTheClaim(t *testing.T) {
	s, d, _, _ := notifySvc(false, "invite")
	if _, err := s.Notify(context.Background(), "event"); !errors.Is(err, ErrPushFailed) {
		t.Fatalf("want ErrPushFailed, got %v", err)
	}
	if d.seen["j1"] {
		t.Fatal("the jti must be released after a failed push")
	}
}

func TestNotifyFriendIsNotATable(t *testing.T) {
	s, _, tb, _ := notifySvc(true, "friend")
	if _, err := s.Notify(context.Background(), "event"); err != nil {
		t.Fatal(err)
	}
	if len(tb.remembered) != 0 {
		t.Fatal("a friend request must not create a live table")
	}
}
