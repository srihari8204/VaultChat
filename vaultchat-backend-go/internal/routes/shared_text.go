// shared_text.go — small value and text helpers every feature uses (openspec:
// microservices-prepare). Moved here from chats_helpers.go, stories.go,
// contacts.go and golive_webhook.go; names are unchanged.
package routes

import "fmt"

// chatsStrOr mirrors (v || def).toString() over a JSON any.
func chatsStrOr(v any, def string) string {
	if !chatsTruthy(v) {
		return def
	}
	return fmt.Sprintf("%v", v)
}

func truncRunes(s string, n int) string {
	if runes := []rune(s); len(runes) > n {
		return string(runes[:n])
	}
	return s
}

func orEmpty(v any) any {
	if v == nil {
		return ""
	}
	return v
}

// isUUID reports whether s is shaped like a canonical UUID.
//
// Shape only — this is a filter for "could this be a user id", not validation.
// The database is still the authority on whether the id exists and whether it
// is the host; this just keeps non-user participants (egress, and any future
// SIP or agent joiner) from reaching a uuid-typed column at all.
func isUUID(s string) bool {
	if len(s) != 36 {
		return false
	}
	for i, c := range s {
		if i == 8 || i == 13 || i == 18 || i == 23 {
			if c != '-' {
				return false
			}
			continue
		}
		if !(c >= '0' && c <= '9' || c >= 'a' && c <= 'f' || c >= 'A' && c <= 'F') {
			return false
		}
	}
	return true
}
