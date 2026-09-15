package routes

import (
	"context"
	"errors"
	"testing"

	"github.com/jackc/pgx/v5/pgconn"
)

func TestRegisterFcmDeviceRequiresPersistedToken(t *testing.T) {
	insertErr := errors.New("insert failed")
	for _, tc := range []struct {
		name      string
		insertOK  bool
		updateTag string
		updateErr error
		wantErr   bool
	}{
		{"insert", true, "", nil, false},
		{"existing token", false, "UPDATE 1", nil, false},
		{"missing token", false, "UPDATE 0", nil, true},
		{"fallback failure", false, "", errors.New("update failed"), true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			calls := 0
			exec := func(_ context.Context, _ string, _ ...any) (pgconn.CommandTag, error) {
				calls++
				if calls == 1 {
					if tc.insertOK {
						return pgconn.NewCommandTag("INSERT 0 1"), nil
					}
					return pgconn.CommandTag{}, insertErr
				}
				return pgconn.NewCommandTag(tc.updateTag), tc.updateErr
			}
			err := registerFcmDeviceWithExec(context.Background(), exec, "user", "token", "android")
			if tc.wantErr && !errors.Is(err, insertErr) {
				t.Fatalf("want original insert error, got %v", err)
			}
			if !tc.wantErr && err != nil {
				t.Fatal(err)
			}
			if tc.insertOK && calls != 1 {
				t.Fatalf("unnecessary fallback: %d calls", calls)
			}
		})
	}
}
