// Package postgres implements Games' storage ports — players, the live-tables
// list, notify dedupe and matches — on the shared pool (openspec:
// hexagonal-architecture). RLS is inert in production (the API connects as a
// superuser), so every query here scopes by user itself.
package postgres

import (
	"context"
	"encoding/json"
	"errors"
	"log"
	"time"

	"github.com/jackc/pgx/v5"

	"vaultchat/backend-go/internal/db"
	"vaultchat/backend-go/internal/games/app"
	"vaultchat/backend-go/internal/games/domain"
	"vaultchat/backend-go/internal/vault"
)

type Store struct{}

var (
	_ app.Players = Store{}
	_ app.Tables  = Store{}
	_ app.Dedupe  = Store{}
	_ app.Matches = Store{}
)

// Player reads the name from the ciphers, not users.name: accounts made through
// vault onboarding leave the legacy plaintext column NULL, which is how real
// players once sat in the lobby as `v337da54a1d30`.
func (Store) Player(ctx context.Context, userID string) (domain.Player, error) {
	var p domain.Player
	var fnc, lnc, legacyName *string
	if err := db.Pool.QueryRow(ctx,
		`SELECT COALESCE(vault_id, ''), first_name_cipher, last_name_cipher, name
		   FROM users WHERE id = $1 AND is_deleted = FALSE`,
		userID,
	).Scan(&p.VaultID, &fnc, &lnc, &legacyName); err != nil {
		return domain.Player{}, app.ErrUserNotFound
	}
	p.Name = vault.IdentityFromRow(fnc, lnc, nil, nil, nil, nil, legacyName, nil, nil, nil, nil).Name
	return p, nil
}

func (Store) VaultID(ctx context.Context, userID string) (string, error) {
	var vid *string
	if err := db.Pool.QueryRow(ctx, `SELECT vault_id FROM users WHERE id = $1`, userID).Scan(&vid); err != nil {
		return "", err
	}
	if vid == nil {
		return "", nil
	}
	return *vid, nil
}

func (Store) UserIDForVault(ctx context.Context, vaultID string) (string, error) {
	var id string
	err := db.Pool.QueryRow(ctx,
		`SELECT id::text FROM users WHERE vault_id = $1 AND is_deleted = FALSE`, vaultID).Scan(&id)
	return id, err
}

// liveTablesSQL reads ONE player's tables. The `user_id = $1` is the entire
// access control; a named constant so a test can assert it is still here.
const liveTablesSQL = `
	SELECT game, room, your_turn, COALESCE(title, ''), COALESCE(body, ''), updated_at
	  FROM games_live_tables
	 WHERE user_id = $1
	 ORDER BY updated_at DESC
	 LIMIT 50`

func (Store) List(ctx context.Context, userID string) ([]domain.LiveTable, error) {
	rows, err := db.Pool.Query(ctx, liveTablesSQL, userID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := make([]domain.LiveTable, 0, 8)
	for rows.Next() {
		var t domain.LiveTable
		if err := rows.Scan(&t.Game, &t.Room, &t.YourTurn, &t.Title, &t.Body, &t.UpdatedAt); err != nil {
			continue // one unreadable row must not blank the whole list
		}
		out = append(out, t)
	}
	return out, nil
}

func (Store) Remember(ctx context.Context, userID string, t domain.LiveTable) error {
	_, err := db.Pool.Exec(ctx,
		`INSERT INTO games_live_tables (user_id, game, room, your_turn, title, body, updated_at)
		 VALUES ($1, $2, $3, $4, NULLIF($5, ''), NULLIF($6, ''), now())
		 ON CONFLICT (user_id, game, room) DO UPDATE
		    SET your_turn = EXCLUDED.your_turn,
		        title      = EXCLUDED.title,
		        body       = EXCLUDED.body,
		        updated_at = now()`,
		userID, t.Game, t.Room, t.YourTurn, t.Title, t.Body)
	if err != nil {
		log.Printf("[games-notify] live table upsert failed: %v", err)
	}
	return err
}

// Forget is scoped to the caller's own row: knowing somebody else's room id is
// not a capability to edit their list.
func (Store) Forget(ctx context.Context, userID, game, room string) error {
	_, err := db.Pool.Exec(ctx,
		`DELETE FROM games_live_tables WHERE user_id = $1 AND game = $2 AND room = $3`,
		userID, game, room)
	return err
}

// Claim lets the unique index do the work: concurrent deliveries of one jti
// race into one INSERT, exactly one affects a row. No read-then-write window.
func (Store) Claim(ctx context.Context, jti string, expires time.Time) (bool, error) {
	tag, err := db.Pool.Exec(ctx,
		`INSERT INTO games_notify_seen (jti, expires_at) VALUES ($1, $2)
		 ON CONFLICT (jti) DO NOTHING`, jti, expires)
	if err != nil {
		log.Printf("[games-notify] dedupe insert failed: %v", err)
		return false, err
	}
	return tag.RowsAffected() > 0, nil
}

func (Store) Release(ctx context.Context, jti string) {
	if _, err := db.Pool.Exec(ctx, `DELETE FROM games_notify_seen WHERE jti = $1`, jti); err != nil {
		log.Printf("[games-notify] dedupe release failed: %v", err)
	}
}

// decodeScores never fails a request over a bad blob: an unreadable scoreboard
// reads as an empty one ("no scores yet"), not an error screen over a live game.
func decodeScores(raw []byte) map[string]domain.Score {
	out := map[string]domain.Score{}
	if len(raw) > 0 {
		_ = json.Unmarshal(raw, &out)
	}
	return out
}

func scanMatch(row pgx.Row, tableID string) (domain.Match, error) {
	m := domain.Match{TableID: tableID}
	var v string
	var raw []byte
	if err := row.Scan(&m.ID, &v, &m.Status, &m.DealsPlayed, &raw); err != nil {
		return domain.Match{}, err
	}
	m.Variant, m.Scores = domain.Variant(v), decodeScores(raw)
	return m, nil
}

// Open is one statement either way: insert, or read back the running row the
// partial unique index (migration 126) kept the insert from duplicating.
func (Store) Open(ctx context.Context, tableID string, v domain.Variant, hostVaultID string) (domain.Match, error) {
	return scanMatch(db.Pool.QueryRow(ctx, `
		WITH ins AS (
		  INSERT INTO games_matches (table_id, variant, host_vault_id, scores)
		  VALUES ($1, $2, $3, '{}'::JSONB)
		  ON CONFLICT (table_id) WHERE status = 'running' DO NOTHING
		  RETURNING id, variant, status, deals_played, scores
		)
		SELECT id, variant, status, deals_played, scores FROM ins
		UNION ALL
		SELECT id, variant, status, deals_played, scores FROM games_matches
		  WHERE table_id = $1 AND status = 'running'
		LIMIT 1`,
		tableID, string(v), hostVaultID), tableID)
}

func (Store) Running(ctx context.Context, tableID string) (*domain.Match, error) {
	m, err := scanMatch(db.Pool.QueryRow(ctx, `
		SELECT id, variant, status, deals_played, scores
		  FROM games_matches
		 WHERE table_id = $1 AND status = 'running'`, tableID), tableID)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &m, nil
}

func (Store) Get(ctx context.Context, id string) (domain.Match, error) {
	var tableID string
	m := domain.Match{ID: id}
	var v string
	var raw []byte
	err := db.Pool.QueryRow(ctx, `
		SELECT table_id, variant, status, deals_played, scores
		  FROM games_matches WHERE id = $1`, id,
	).Scan(&tableID, &v, &m.Status, &m.DealsPlayed, &raw)
	if errors.Is(err, pgx.ErrNoRows) {
		return domain.Match{}, app.ErrMatchNotFound
	} else if err != nil {
		return domain.Match{}, err
	}
	m.TableID, m.Variant, m.Scores = tableID, domain.Variant(v), decodeScores(raw)
	return m, nil
}

// Advance: the WHERE deals_played = fromDeals is the exactly-once guard.
func (Store) Advance(ctx context.Context, next domain.Match, fromDeals int) (bool, error) {
	encoded, err := json.Marshal(next.Scores)
	if err != nil {
		return false, err
	}
	var ok bool
	err = db.Pool.QueryRow(ctx, `
		UPDATE games_matches
		   SET scores = $1, deals_played = $2, status = $3, updated_at = now()
		 WHERE id = $4 AND deals_played = $5 AND status = 'running'
		RETURNING TRUE`,
		// string, not []byte: in exec mode pgx sends []byte as bytea, which a
		// JSONB column refuses (see routes/jsonbparam_test.go).
		string(encoded), next.DealsPlayed, next.Status, next.ID, fromDeals,
	).Scan(&ok)
	if errors.Is(err, pgx.ErrNoRows) {
		return false, nil
	}
	return err == nil, err
}
