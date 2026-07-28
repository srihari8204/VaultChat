// ai.go ← routes/ai.js — on-prem AI via Ollama. Same rate limit (fail-open),
// same 503 "honest unavailable" behavior, same task prompts.
package routes

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"regexp"
	"strings"
	"time"

	"vaultchat/backend-go/internal/httpx"
	"vaultchat/backend-go/internal/redisx"
)

const aiTimeout = 30 * time.Second

var aiTasks = map[string]string{
	"summarize": "Summarize the following conversation in 2-3 short bullet points. Be neutral and concise:",
	"suggest":   "Suggest three short, natural reply options to the following message. Return only a numbered list:",
	"translate": "Detect the language of the following text and translate it to English (if it is already English, translate to Spanish). Return only the translation:",
	"tone":      "Describe the tone of the following message in one short sentence:",
	"grammar":   "Rewrite the following text with correct grammar and spelling, keeping its meaning and tone. Return only the corrected text:",
	"shorten":   "Rewrite the following text to be shorter and clearer. Return only the rewritten text:",
}

func RegisterAI(mux *http.ServeMux) {
	mux.HandleFunc("POST /ai/chat", httpx.RequireAuth(aiLimited(aiChat)))
	mux.HandleFunc("POST /ai/assist", httpx.RequireAuth(aiLimited(aiAssist)))
}

// aiLimited mirrors the router-level 30/min limiter (fail-open in redisx).
func aiLimited(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		rl := redisx.Consume(r.Context(), "ai:"+httpx.UserFrom(r).ID, 30, 60)
		if !rl.Allowed {
			httpx.Err(w, 429, "Too many AI requests — slow down", map[string]any{"retryAfter": rl.ResetInSec})
			return
		}
		next(w, r)
	}
}

func ollama(ctx context.Context, path string, body map[string]any) (map[string]any, error) {
	base := strings.TrimSuffix(envOrDefault("OLLAMA_URL", "http://localhost:11434"), "/")
	model := envOrDefault("OLLAMA_MODEL", "llama3.2")
	payload := map[string]any{"model": model, "stream": false}
	for k, v := range body {
		payload[k] = v
	}
	data, _ := json.Marshal(payload)
	ctx, cancel := context.WithTimeout(ctx, aiTimeout)
	defer cancel()
	req, _ := http.NewRequestWithContext(ctx, "POST", base+path, bytes.NewReader(data))
	req.Header.Set("Content-Type", "application/json")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		return nil, fmt.Errorf("Ollama %d", resp.StatusCode)
	}
	var out map[string]any
	if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
		return nil, err
	}
	return out, nil
}

func aiChat(w http.ResponseWriter, r *http.Request) {
	var b struct {
		Message any   `json:"message"`
		History []any `json:"history"`
	}
	_ = httpx.Body(r, &b)
	message := strings.TrimSpace(truncRunes(fmt.Sprintf("%v", orEmpty(b.Message)), 2000))
	if message == "" {
		httpx.Err(w, 400, "message required")
		return
	}
	history := b.History
	if len(history) > 10 {
		history = history[len(history)-10:]
	}

	messages := []map[string]any{{
		"role":    "system",
		"content": "You are Aria, VaultChat's helpful, privacy-respecting assistant. Be concise, friendly, and never claim to access the user's private messages.",
	}}
	for _, h := range history {
		hm, _ := h.(map[string]any)
		role := "assistant"
		if hm["role"] == "user" {
			role = "user"
		}
		messages = append(messages, map[string]any{
			"role":    role,
			"content": truncRunes(fmt.Sprintf("%v", orEmpty(hm["content"])), 2000),
		})
	}
	messages = append(messages, map[string]any{"role": "user", "content": message})

	j, err := ollama(r.Context(), "/api/chat", map[string]any{"messages": messages})
	if err != nil {
		httpx.Err(w, 503, "AI is unavailable right now")
		return
	}
	reply := ""
	if m, ok := j["message"].(map[string]any); ok {
		reply, _ = m["content"].(string)
	}
	httpx.JSON(w, 200, map[string]any{"reply": strings.TrimSpace(reply)})
}

var aiLangRe = regexp.MustCompile(`[^a-zA-Z \-]`)

func aiAssist(w http.ResponseWriter, r *http.Request) {
	var b struct {
		Task any `json:"task"`
		Text any `json:"text"`
		Lang any `json:"lang"`
	}
	_ = httpx.Body(r, &b)
	task := fmt.Sprintf("%v", orEmpty(b.Task))
	text := strings.TrimSpace(truncRunes(fmt.Sprintf("%v", orEmpty(b.Text)), 4000))
	instruction, ok := aiTasks[task]
	if !ok {
		httpx.Err(w, 400, "unknown task")
		return
	}
	if text == "" {
		httpx.Err(w, 400, "text required")
		return
	}
	if task == "translate" {
		lang := strings.TrimSpace(truncRunes(aiLangRe.ReplaceAllString(fmt.Sprintf("%v", orEmpty(b.Lang)), ""), 40))
		if lang != "" {
			instruction = "Translate the following text to " + lang + ". Return only the translation, nothing else:"
		}
	}
	j, err := ollama(r.Context(), "/api/generate", map[string]any{"prompt": instruction + "\n\n" + text})
	if err != nil {
		httpx.Err(w, 503, "AI is unavailable right now")
		return
	}
	result, _ := j["response"].(string)
	httpx.JSON(w, 200, map[string]any{"result": strings.TrimSpace(result)})
}

func envOrDefault(k, def string) string {
	if v := os.Getenv(k); v != "" {
		return v
	}
	return def
}
