package realtime

import (
	"log"
	"strconv"
	"strings"
	"time"

	"github.com/zishang520/socket.io/v2/socket"

	"vaultchat/backend-go/internal/db"
	"vaultchat/backend-go/internal/httpx"
)

// ── In-memory game state (server.js io.gamePlayers/gameRooms/gameMatchQueue) ──
// Ephemeral — coins, rooms, queue lost on restart (acceptable until the wallet
// moves to Postgres). gameStore below write-throughs coins/wins/match log.
//
// ponytail: one global lock (h.gmu) guards all three maps AND wraps the
// gameStore DB calls inline (matching Node's single-threaded handlers). Games
// are low-volume, so serializing them is fine; split to per-room locks only if
// throughput ever matters.

type gamePlayer struct {
	uid      string
	name     string
	socketID string
	coins    int
	wins     int
	inGame   bool
}

type gamePlayerRef struct {
	uid      string
	name     string
	socketID string
}

type gameRoom struct {
	id        string
	gameType  string
	bet       int
	players   []*gamePlayerRef
	turn      string
	startedAt int64
}

type queueEntry struct {
	uid      string
	name     string
	socketID string
	gameType string
	bet      int
}

func toInt(v any) int {
	switch t := v.(type) {
	case float64:
		return int(t)
	case int:
		return t
	case string:
		n, _ := httpx.ParseIntPrefix(t)
		return int(n)
	}
	return 0
}

func (h *Hub) socketByID(id string) *socket.Socket {
	s, ok := h.io.Sockets().Sockets().Load(socket.SocketId(id))
	if !ok {
		return nil
	}
	return s
}

func (h *Hub) registerGameHandlers(s *socket.Socket) {
	d := sd(s)

	s.On("game_join_lobby", func(args ...any) {
		me := d.uid
		if me == "" {
			return
		}
		coins, wins, err := gameLoadProfile(me)
		if err != nil {
			log.Printf("[game_join_lobby] %v", err)
			coins, wins = 1000, 0
		}
		name := mstr(argMap(args), "name")
		if name == "" {
			name = d.email
		}
		if name == "" {
			name = "Player"
		}
		h.gmu.Lock()
		h.gamePlayers[me] = &gamePlayer{uid: me, name: name, socketID: string(s.Id()), coins: coins, wins: wins}
		h.gmu.Unlock()
		s.Join(socket.Room("game_lobby"))
		s.Emit("game_coins", map[string]any{"coins": coins})
	})

	s.On("game_leave_lobby", func(_ ...any) { s.Leave(socket.Room("game_lobby")) })

	s.On("game_quick_match", func(args ...any) { h.onQuickMatch(s, argMap(args)) })

	s.On("game_cancel_match", func(args ...any) {
		m := argMap(args)
		wager := toInt(m["bet"])
		if wager < 0 {
			wager = 0
		}
		waitKey := mstr(m, "gameType") + "_" + strconv.Itoa(wager)
		h.gmu.Lock()
		if w := h.gameQueue[waitKey]; w != nil && w.uid == d.uid {
			delete(h.gameQueue, waitKey)
		}
		h.gmu.Unlock()
		s.Emit("game_match_cancelled", map[string]any{})
	})

	s.On("game_rejoin", func(args ...any) {
		me := d.uid
		roomID := mstr(argMap(args), "roomId")
		h.gmu.Lock()
		room := h.gameRooms[roomID]
		if room == nil {
			h.gmu.Unlock()
			s.Emit("game_error", map[string]any{"message": "Match no longer active"})
			return
		}
		var mine *gamePlayerRef
		for _, p := range room.players {
			if p.uid == me {
				mine = p
				break
			}
		}
		if mine == nil {
			h.gmu.Unlock()
			return
		}
		mine.socketID = string(s.Id())
		yourTurn := room.turn == me
		h.gmu.Unlock()
		d.mu.Lock()
		d.gameRoomID = roomID
		d.mu.Unlock()
		s.Join(socket.Room("game:" + roomID))
		s.Emit("game_rejoined", map[string]any{"roomId": roomID, "yourTurn": yourTurn})
	})

	s.On("game_move", func(args ...any) {
		m := argMap(args)
		roomID := mstr(m, "roomId")
		h.gmu.Lock()
		defer h.gmu.Unlock()
		room := h.gameRooms[roomID]
		if room == nil {
			return
		}
		s.To(socket.Room("game:"+roomID)).Emit("game_move", map[string]any{"uid": d.uid, "move": m["move"]})
		next := d.uid
		for _, p := range room.players {
			if p.uid != d.uid {
				next = p.uid
				break
			}
		}
		room.turn = next
	})

	s.On("game_end", func(args ...any) {
		m := argMap(args)
		h.settleGame(mstr(m, "roomId"), mstr(m, "winnerId"), m["reason"])
	})

	s.On("game_chat", func(args ...any) {
		m := argMap(args)
		if roomID := mstr(m, "roomId"); roomID != "" {
			s.To(socket.Room("game:"+roomID)).Emit("game_chat", map[string]any{"uid": d.uid, "text": m["text"]})
		}
	})
}

func (h *Hub) onQuickMatch(s *socket.Socket, m map[string]any) {
	d := sd(s)
	me := d.uid
	gameType := mstr(m, "gameType")
	wager := toInt(m["bet"])
	if wager < 0 {
		wager = 0
	}

	h.gmu.Lock()
	defer h.gmu.Unlock()

	player := h.gamePlayers[me]
	if player == nil {
		return
	}
	if player.coins < wager {
		s.Emit("game_error", map[string]any{"message": "Not enough coins"})
		return
	}
	waitKey := gameType + "_" + strconv.Itoa(wager)
	waiting := h.gameQueue[waitKey]
	if waiting != nil && waiting.uid != me {
		delete(h.gameQueue, waitKey)
		roomID := "GAME-" + strings.ToUpper(strconv.FormatInt(time.Now().UnixMilli(), 36))
		room := &gameRoom{
			id: roomID, gameType: gameType, bet: wager,
			players: []*gamePlayerRef{
				{uid: waiting.uid, name: waiting.name, socketID: waiting.socketID},
				{uid: me, name: player.name, socketID: string(s.Id())},
			},
			turn: waiting.uid, startedAt: time.Now().UnixMilli(),
		}
		h.gameRooms[roomID] = room

		// Persist: log the match + deduct the wager from both balances.
		if err := gameRecordMatch(room); err != nil {
			log.Printf("[game_quick_match persist] %v", err)
		}
		aCoins, aErr := gameAdjustCoins(waiting.uid, -wager)
		bCoins, bErr := gameAdjustCoins(me, -wager)
		if aErr != nil || bErr != nil {
			log.Printf("[game_quick_match persist] a=%v b=%v", aErr, bErr)
		}
		if wp := h.gamePlayers[waiting.uid]; wp != nil {
			wp.coins = aCoins
			wp.inGame = true
		}
		player.coins = bCoins
		player.inGame = true

		if ws := h.socketByID(waiting.socketID); ws != nil {
			if wd := sd(ws); wd != nil {
				wd.mu.Lock()
				wd.gameRoomID = roomID
				wd.mu.Unlock()
			}
			ws.Emit("game_matched", map[string]any{
				"roomId": roomID, "gameType": gameType, "bet": wager,
				"opponent": map[string]any{"uid": me, "name": player.name}, "yourTurn": true,
			})
			ws.Emit("game_coins", map[string]any{"coins": coinsOf(h.gamePlayers[waiting.uid])})
			ws.Join(socket.Room("game:" + roomID))
		}
		d.mu.Lock()
		d.gameRoomID = roomID
		d.mu.Unlock()
		s.Emit("game_matched", map[string]any{
			"roomId": roomID, "gameType": gameType, "bet": wager,
			"opponent": map[string]any{"uid": waiting.uid, "name": waiting.name}, "yourTurn": false,
		})
		s.Emit("game_coins", map[string]any{"coins": player.coins})
		s.Join(socket.Room("game:" + roomID))
	} else {
		h.gameQueue[waitKey] = &queueEntry{uid: me, name: player.name, socketID: string(s.Id()), gameType: gameType, bet: wager}
		s.Emit("game_waiting", map[string]any{"gameType": gameType, "bet": wager})
	}
}

// settleGame pays the winner the pot, persists, notifies, cleans up (server.js).
func (h *Hub) settleGame(roomID, winnerID string, reason any) {
	h.gmu.Lock()
	defer h.gmu.Unlock()
	room := h.gameRooms[roomID]
	if room == nil {
		return
	}
	delete(h.gameRooms, roomID)
	pot := room.bet * 2
	loserID := ""
	for _, p := range room.players {
		if p.uid != winnerID {
			loserID = p.uid
			break
		}
	}
	winnerCoins, err := gameFinishMatch(roomID, winnerID, loserID, pot)
	if err != nil {
		log.Printf("[settleGame persist] %v", err)
	}
	if winnerID != "" {
		if wp := h.gamePlayers[winnerID]; wp != nil {
			if winnerCoins != nil {
				wp.coins = *winnerCoins
			} else {
				wp.coins += pot
			}
			wp.wins++
			wp.inGame = false
		}
	}
	if loserID != "" {
		if lp := h.gamePlayers[loserID]; lp != nil {
			lp.inGame = false
		}
	}
	var wid any = winnerID
	if winnerID == "" {
		wid = nil
	}
	h.io.To(socket.Room("game:"+roomID)).Emit("game_ended", map[string]any{"winnerId": wid, "totalPot": pot, "reason": reason})
	for _, p := range room.players {
		if sock := h.socketByID(p.socketID); sock != nil {
			sock.Leave(socket.Room("game:" + roomID))
			if pd := sd(sock); pd != nil {
				pd.mu.Lock()
				pd.gameRoomID = ""
				pd.mu.Unlock()
			}
			sock.Emit("game_coins", map[string]any{"coins": coinsOf(h.gamePlayers[p.uid])})
		}
	}
}

// onGameDisconnect drops the socket from any queue + forfeits an active game
// (server.js disconnect handler, game portion).
func (h *Hub) onGameDisconnect(s *socket.Socket) {
	d := sd(s)
	sid := string(s.Id())
	h.gmu.Lock()
	for k, w := range h.gameQueue {
		if w.socketID == sid {
			delete(h.gameQueue, k)
		}
	}
	d.mu.Lock()
	roomID := d.gameRoomID
	d.mu.Unlock()
	winnerID, hasRoom := "", false
	if roomID != "" {
		if room := h.gameRooms[roomID]; room != nil {
			hasRoom = true
			for _, p := range room.players {
				if p.uid != d.uid {
					winnerID = p.uid
					break
				}
			}
		}
	}
	h.gmu.Unlock()
	if hasRoom {
		h.settleGame(roomID, winnerID, "opponent_left")
	}
}

func coinsOf(p *gamePlayer) int {
	if p == nil {
		return 0
	}
	return p.coins
}

// ── gameStore (verbatim port of gameStore.js) ─────────────────────────

func gameLoadProfile(uid string) (coins, wins int, err error) {
	err = db.Pool.QueryRow(bg,
		`INSERT INTO game_profiles (user_id) VALUES ($1)
		   ON CONFLICT (user_id) DO UPDATE SET user_id = game_profiles.user_id
		 RETURNING coins, wins`, uid).Scan(&coins, &wins)
	return
}

func gameAdjustCoins(uid string, delta int) (int, error) {
	var coins int
	err := db.Pool.QueryRow(bg,
		`UPDATE game_profiles SET coins = GREATEST(0, coins + $2), updated_at = NOW()
		  WHERE user_id = $1 RETURNING coins`, uid, delta).Scan(&coins)
	return coins, err
}

func gameRecordMatch(room *gameRoom) error {
	_, err := db.Pool.Exec(bg,
		`INSERT INTO game_matches (id, game_type, player_a, player_b, bet)
		 VALUES ($1, $2, $3, $4, $5) ON CONFLICT (id) DO NOTHING`,
		room.id, room.gameType, room.players[0].uid, room.players[1].uid, room.bet)
	return err
}

// gameFinishMatch stamps the winner, bumps records, pays the pot. Returns the
// winner's new balance (nil when there's no winner or no row updated).
func gameFinishMatch(roomID, winnerID, loserID string, pot int) (*int, error) {
	var winnerArg any
	if winnerID != "" {
		winnerArg = winnerID
	}
	if _, err := db.Pool.Exec(bg,
		`UPDATE game_matches SET winner_id = $2, status = 'finished', ended_at = NOW()
		  WHERE id = $1 AND status = 'active'`, roomID, winnerArg); err != nil {
		return nil, err
	}
	var winnerCoins *int
	if winnerID != "" {
		var c int
		if err := db.Pool.QueryRow(bg,
			`UPDATE game_profiles
			    SET coins = coins + $2, wins = wins + 1, games_played = games_played + 1, updated_at = NOW()
			  WHERE user_id = $1 RETURNING coins`, winnerID, pot).Scan(&c); err == nil {
			winnerCoins = &c
		}
	}
	if loserID != "" {
		_, _ = db.Pool.Exec(bg,
			`UPDATE game_profiles
			    SET losses = losses + 1, games_played = games_played + 1, updated_at = NOW()
			  WHERE user_id = $1`, loserID)
	}
	return winnerCoins, nil
}
