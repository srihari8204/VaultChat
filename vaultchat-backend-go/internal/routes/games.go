// games.go ← routes/games.js — durable gaming profile/history/leaderboard.
// The realtime matchmaking stays in the Node Socket.IO layer until Step 5.
package routes

import (
	"net/http"
	"time"

	"vaultchat/backend-go/internal/db"
	"vaultchat/backend-go/internal/httpx"
)

func RegisterGames(mux *http.ServeMux) {
	mux.HandleFunc("GET /games/profile", httpx.RequireAuth(gamesProfile))
	mux.HandleFunc("GET /games/history", httpx.RequireAuth(gamesHistory))
	mux.HandleFunc("GET /games/leaderboard", httpx.RequireAuth(gamesLeaderboard))
}

// gamesProfile mirrors gameStore.loadProfile: upsert-with-defaults, then echo.
func gamesProfile(w http.ResponseWriter, r *http.Request) {
	var coins, wins, losses, played int
	err := db.Pool.QueryRow(r.Context(),
		`INSERT INTO game_profiles (user_id) VALUES ($1)
		   ON CONFLICT (user_id) DO UPDATE SET user_id = game_profiles.user_id
		 RETURNING coins, wins, losses, games_played`,
		httpx.UserFrom(r).ID).Scan(&coins, &wins, &losses, &played)
	if err != nil {
		httpx.Err(w, 500, "Failed to load game profile")
		return
	}
	httpx.JSON(w, 200, map[string]any{
		"coins": coins, "wins": wins, "losses": losses, "gamesPlayed": played,
	})
}

func gamesHistory(w http.ResponseWriter, r *http.Request) {
	user := httpx.UserFrom(r)
	rows, err := db.Pool.Query(r.Context(),
		`SELECT m.id, m.game_type, m.bet, m.winner_id, m.status, m.started_at, m.ended_at,
		        CASE WHEN m.player_a = $1 THEN m.player_b ELSE m.player_a END AS opponent_id,
		        COALESCE(NULLIF(u.name, ''), u.email) AS opponent_name
		   FROM game_matches m
		   JOIN users u ON u.id = CASE WHEN m.player_a = $1 THEN m.player_b ELSE m.player_a END
		  WHERE m.player_a = $1 OR m.player_b = $1
		  ORDER BY m.started_at DESC LIMIT 30`, user.ID)
	if err != nil {
		httpx.Err(w, 500, "Failed to load match history")
		return
	}
	defer rows.Close()
	type match struct {
		ID           string        `json:"id"`
		GameType     string        `json:"gameType"`
		Bet          int           `json:"bet"`
		OpponentID   string        `json:"opponentId"`
		OpponentName *string       `json:"opponentName"`
		Result       string        `json:"result"`
		StartedAt    httpx.JSTime  `json:"startedAt"`
		EndedAt      *httpx.JSTime `json:"endedAt"`
	}
	out := []match{}
	for rows.Next() {
		var id, gameType, status, opponentID string
		var winnerID, opponentName *string
		var bet int
		var startedAt time.Time
		var endedAt *time.Time
		if err := rows.Scan(&id, &gameType, &bet, &winnerID, &status, &startedAt, &endedAt,
			&opponentID, &opponentName); err != nil {
			httpx.Err(w, 500, "Failed to load match history")
			return
		}
		result := status
		if status == "finished" {
			switch {
			case winnerID != nil && *winnerID == user.ID:
				result = "win"
			case winnerID != nil:
				result = "loss"
			default:
				result = "draw"
			}
		}
		out = append(out, match{ID: id, GameType: gameType, Bet: bet, OpponentID: opponentID,
			OpponentName: opponentName, Result: result,
			StartedAt: httpx.JSTime(startedAt), EndedAt: httpx.JST(endedAt)})
	}
	httpx.JSON(w, 200, out)
}

func gamesLeaderboard(w http.ResponseWriter, r *http.Request) {
	user := httpx.UserFrom(r)
	rows, err := db.Pool.Query(r.Context(),
		`SELECT gp.user_id, gp.coins, gp.wins, gp.losses, gp.games_played,
		        COALESCE(NULLIF(u.name, ''), u.email) AS name
		   FROM game_profiles gp JOIN users u ON u.id = gp.user_id
		  WHERE gp.games_played > 0
		  ORDER BY gp.wins DESC, gp.coins DESC
		  LIMIT 50`)
	if err != nil {
		httpx.Err(w, 500, "Failed to load leaderboard")
		return
	}
	defer rows.Close()
	type entry struct {
		Rank        int     `json:"rank"`
		UserID      string  `json:"userId"`
		Name        *string `json:"name"`
		Coins       int     `json:"coins"`
		Wins        int     `json:"wins"`
		Losses      int     `json:"losses"`
		GamesPlayed int     `json:"gamesPlayed"`
		IsMe        bool    `json:"isMe"`
	}
	out := []entry{}
	for rows.Next() {
		var e entry
		if err := rows.Scan(&e.UserID, &e.Coins, &e.Wins, &e.Losses, &e.GamesPlayed, &e.Name); err != nil {
			httpx.Err(w, 500, "Failed to load leaderboard")
			return
		}
		e.Rank = len(out) + 1
		e.IsMe = e.UserID == user.ID
		out = append(out, e)
	}
	httpx.JSON(w, 200, out)
}
