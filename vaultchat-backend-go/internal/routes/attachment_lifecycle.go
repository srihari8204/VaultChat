// attachment_lifecycle.go — safe replacement and deletion for the reference-
// counted content classes (profile photos, group photos).
//
// WHY THIS EXISTS
// ---------------
// Migration 100 made purpose authoritative, and the sweep no longer deletes
// anything classed 'profile' or 'group'. That closed a data-loss bug (avatars
// were being deleted 14 days after upload) and opened a storage leak in the
// same move: a superseded avatar is still classed 'profile', so nothing ever
// reclaims it. Every photo change left an orphan that was now protected
// forever.
//
// Reference-counted classes cannot be reclaimed by age — that is the whole
// point of protecting them — so they must be reclaimed by REPLACEMENT. The
// object dies when the last reference to it goes away, and the only code that
// knows that has happened is the code that moved the reference.
//
// ORDERING IS THE ENTIRE CONTRACT
//
//  1. verify the NEW object exists and belongs to the caller
//  2. move the reference
//  3. only then retire the OLD object
//
// Any other order can destroy the live photo. Retiring first and then failing
// to update leaves the user with a reference to bytes that are gone; not
// verifying first lets a bad id blank a working avatar. So the failure mode of
// every step below is "keep the old photo", never "lose both".
package routes

import (
	"context"
	"log"
	"os"
	"path/filepath"

	"github.com/jackc/pgx/v5"

	"vaultchat/backend-go/internal/db"
	"vaultchat/backend-go/internal/storage"
)

// attRemoveDiskObject deletes a disk-backed object, mirroring the path
// convention in uploads.go (relative path under upDir()).
func attRemoveDiskObject(relPath string) {
	if relPath == "" {
		return
	}
	_ = os.Remove(filepath.Join(upDir(), filepath.FromSlash(relPath)))
}

// attVerifyOwned confirms an attachment exists, is not purged, and belongs to
// the caller — then stamps the purpose the SERVER decided, not the client.
//
// Per §D the endpoint is authoritative about purpose: a profile endpoint
// produces a profile object whatever the uploader claimed, and an old client
// that sent nothing still gets classified correctly instead of falling into
// 'unknown'. This is also the authorization check that stops a caller pointing
// their avatar at somebody else's object.
func attVerifyOwned(ctx context.Context, tx pgx.Tx, attID, ownerID, purpose string) error {
	var got string
	err := tx.QueryRow(ctx,
		`UPDATE attachments
		    SET purpose = $3
		  WHERE id = $1::uuid
		    AND owner_user_id = $2
		    AND purged_at IS NULL
		    AND storage_path IS NOT NULL
		  RETURNING id::text`,
		attID, ownerID, purpose).Scan(&got)
	return err
}

// attRetire deletes the stored object and stamps the row purged.
//
// Best-effort by design, and called only AFTER the new reference is committed.
// A failure here costs storage; failing the user's photo change over it would
// cost them the operation they actually asked for. Idempotent: a second call
// matches nothing because purged_at is already set.
func attRetire(ctx context.Context, attID string) {
	if attID == "" {
		return
	}
	var path string
	var backend *string
	err := db.SysPool.QueryRow(ctx,
		`SELECT storage_path, storage_backend FROM attachments
		  WHERE id = $1::uuid AND purged_at IS NULL`, attID).Scan(&path, &backend)
	if err != nil {
		return // already retired, or never existed — both fine
	}
	if backend != nil && *backend == "s3" {
		storage.DeleteObject(ctx, path)
	} else {
		attRemoveDiskObject(path)
	}
	if _, err := db.SysPool.Exec(ctx,
		`UPDATE attachments SET purged_at = NOW() WHERE id = $1::uuid AND purged_at IS NULL`,
		attID); err != nil {
		log.Printf("[attachment retire] %s: %v", attID, err)
	}
}

// attSwapRef is the whole lifecycle in one call.
//
// `read` returns the currently referenced attachment id (may be empty).
// `write` moves the reference. Both run inside one transaction so the reference
// can never be half-moved; the old object is retired only after it commits.
//
// newID == "" means DELETE the photo: the reference is cleared and the old
// object retired. That is the same code path, which is why deletion cannot
// drift from replacement.
func attSwapRef(
	ctx context.Context, ownerID, newID, purpose string,
	read func(context.Context, pgx.Tx) (string, error),
	write func(context.Context, pgx.Tx, string) error,
) error {
	var oldID string
	err := db.WithUser(ctx, ownerID, func(tx pgx.Tx) error {
		prev, e := read(ctx, tx)
		if e != nil && !db.NoRows(e) {
			return e
		}
		oldID = prev

		// Verify BEFORE moving the reference. A bad or foreign id must fail the
		// request with the old photo still intact and still referenced.
		if newID != "" {
			if e := attVerifyOwned(ctx, tx, newID, ownerID, purpose); e != nil {
				return e
			}
		}
		return write(ctx, tx, newID)
	})
	if err != nil {
		return err // nothing retired — the old photo is untouched
	}

	// Committed. The old object is now unreferenced and safe to reclaim.
	// Guarded against the no-op change (same id submitted twice), which would
	// otherwise delete the object that was just installed.
	if oldID != "" && oldID != newID {
		attRetire(ctx, oldID)
	}
	return nil
}
