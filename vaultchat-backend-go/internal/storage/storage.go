// Package storage — S3-compatible object store (MinIO dev / R2 prod), port of
// lib/storage.js. Two clients like Node: SERVER endpoint for bucket I/O,
// PUBLIC endpoint baked into presigned URLs. Gated on S3_ENDPOINT +
// S3_ACCESS_KEY; when unset Enabled() is false and callers fall back to disk.
package storage

import (
	"context"
	"errors"
	"io"
	"log"
	"net/url"
	"os"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/minio/minio-go/v7"
	"github.com/minio/minio-go/v7/pkg/credentials"
)

func Bucket() string {
	if b := os.Getenv("S3_BUCKET"); b != "" {
		return b
	}
	return "vaultchat-media"
}

func Enabled() bool {
	return os.Getenv("S3_ENDPOINT") != "" && os.Getenv("S3_ACCESS_KEY") != ""
}

var (
	mu         sync.Mutex
	serverCli  *minio.Client
	signCli    *minio.Client
	serverCore *minio.Core
)

func mkClient(endpoint string) (*minio.Client, error) {
	u, err := url.Parse(endpoint)
	if err != nil {
		return nil, err
	}
	return minio.New(u.Host, &minio.Options{
		Creds:        credentials.NewStaticV4(os.Getenv("S3_ACCESS_KEY"), os.Getenv("S3_SECRET_KEY"), ""),
		Secure:       u.Scheme == "https",
		Region:       envOr("S3_REGION", "auto"),
		BucketLookup: minio.BucketLookupPath, // MinIO + most S3-compatibles need path-style
	})
}

func clients() (*minio.Client, *minio.Core, *minio.Client) {
	mu.Lock()
	defer mu.Unlock()
	if !Enabled() {
		return nil, nil, nil
	}
	if serverCli == nil {
		signEndpoint := os.Getenv("S3_PUBLIC_ENDPOINT")
		if signEndpoint == "" {
			signEndpoint = os.Getenv("S3_ENDPOINT")
		}
		var err error
		if serverCli, err = mkClient(os.Getenv("S3_ENDPOINT")); err != nil {
			log.Printf("[storage] server client: %v", err)
			return nil, nil, nil
		}
		serverCore = &minio.Core{Client: serverCli}
		if signCli, err = mkClient(signEndpoint); err != nil {
			log.Printf("[storage] sign client: %v", err)
			serverCli = nil
			return nil, nil, nil
		}
	}
	return serverCli, serverCore, signCli
}

func envOr(k, def string) string {
	if v := os.Getenv(k); v != "" {
		return v
	}
	return def
}

// PresignPut — client uploads bytes directly to the store.
func PresignPut(ctx context.Context, key, contentType string, expires time.Duration) (string, error) {
	_, _, sign := clients()
	if sign == nil {
		return "", errors.New("storage disabled")
	}
	u, err := sign.PresignedPutObject(ctx, Bucket(), key, expires)
	if err != nil {
		return "", err
	}
	return u.String(), nil
}

// PresignGet — short-lived download URL handed out AFTER the access check.
func PresignGet(ctx context.Context, key string, expires time.Duration) (string, error) {
	_, _, sign := clients()
	if sign == nil {
		return "", errors.New("storage disabled")
	}
	u, err := sign.PresignedGetObject(ctx, Bucket(), key, expires, nil)
	if err != nil {
		return "", err
	}
	return u.String(), nil
}

// GetObject — server-side download → bytes (encrypted-avatar decrypt path).
func GetObject(ctx context.Context, key string) ([]byte, error) {
	cli, _, _ := clients()
	if cli == nil {
		return nil, errors.New("storage disabled")
	}
	obj, err := cli.GetObject(ctx, Bucket(), key, minio.GetObjectOptions{})
	if err != nil {
		return nil, err
	}
	defer obj.Close()
	return io.ReadAll(obj)
}

type ObjectStream struct {
	Body          io.ReadCloser
	ContentLength int64 // -1 when unknown
	ContentType   string
}

// GetObjectStream — server-side relay stream (never buffers), nil on any error
// exactly like Node's getObjectStream.
func GetObjectStream(ctx context.Context, key string) *ObjectStream {
	cli, _, _ := clients()
	if cli == nil {
		return nil
	}
	obj, err := cli.GetObject(ctx, Bucket(), key, minio.GetObjectOptions{})
	if err != nil {
		return nil
	}
	st, err := obj.Stat()
	if err != nil {
		obj.Close()
		return nil
	}
	return &ObjectStream{Body: obj, ContentLength: st.Size, ContentType: st.ContentType}
}

// PutObject — server-side upload, for bytes the server itself produces rather
// than proxies from a client.
func PutObject(ctx context.Context, key string, data []byte, contentType string) error {
	cli, _, _ := clients()
	if cli == nil {
		return errors.New("storage disabled")
	}
	_, err := cli.PutObject(ctx, Bucket(), key, strings.NewReader(string(data)), int64(len(data)),
		minio.PutObjectOptions{ContentType: contentType})
	return err
}

func DeleteObject(ctx context.Context, key string) {
	cli, _, _ := clients()
	if cli == nil {
		return
	}
	if err := cli.RemoveObject(ctx, Bucket(), key, minio.RemoveObjectOptions{}); err != nil {
		log.Printf("[storage] deleteObject: %v", err)
	}
}

func ObjectExists(ctx context.Context, key string) bool {
	cli, _, _ := clients()
	if cli == nil {
		return false
	}
	_, err := cli.StatObject(ctx, Bucket(), key, minio.StatObjectOptions{})
	return err == nil
}

// DeletePrefix — purge every object under a prefix (VaultBeam relay purge).
func DeletePrefix(ctx context.Context, prefix string) {
	cli, _, _ := clients()
	if cli == nil {
		return
	}
	objCh := cli.ListObjects(ctx, Bucket(), minio.ListObjectsOptions{Prefix: prefix, Recursive: true})
	for rErr := range cli.RemoveObjects(ctx, Bucket(), objCh, minio.RemoveObjectsOptions{}) {
		if rErr.Err != nil {
			log.Printf("[storage] deletePrefix: %v", rErr.Err)
		}
	}
}

// ── Resumable multipart (S3 multipart API; R2-compatible) ──────────────

func CreateMultipart(ctx context.Context, key, contentType string) (string, error) {
	_, core, _ := clients()
	if core == nil {
		return "", errors.New("storage disabled")
	}
	return core.NewMultipartUpload(ctx, Bucket(), key, minio.PutObjectOptions{ContentType: contentType})
}

// PresignUploadPart — presigned PUT for one part (partNumber+uploadId signed
// into the query, public endpoint).
func PresignUploadPart(ctx context.Context, key, uploadID string, partNumber int, expires time.Duration) (string, error) {
	_, _, sign := clients()
	if sign == nil {
		return "", errors.New("storage disabled")
	}
	params := url.Values{}
	params.Set("partNumber", strconv.Itoa(partNumber))
	params.Set("uploadId", uploadID)
	u, err := sign.Presign(ctx, "PUT", Bucket(), key, expires, params)
	if err != nil {
		return "", err
	}
	return u.String(), nil
}

type Part struct {
	PartNumber int
	ETag       string
	Size       int64
}

// ListParts — the resume oracle.
func ListParts(ctx context.Context, key, uploadID string) ([]Part, error) {
	_, core, _ := clients()
	if core == nil {
		return nil, errors.New("storage disabled")
	}
	parts := []Part{}
	marker := 0
	for {
		res, err := core.ListObjectParts(ctx, Bucket(), key, uploadID, marker, 1000)
		if err != nil {
			return nil, err
		}
		for _, p := range res.ObjectParts {
			parts = append(parts, Part{PartNumber: p.PartNumber, ETag: p.ETag, Size: p.Size})
		}
		if !res.IsTruncated {
			break
		}
		marker = res.NextPartNumberMarker
	}
	sort.Slice(parts, func(i, j int) bool { return parts[i].PartNumber < parts[j].PartNumber })
	return parts, nil
}

func CompleteMultipart(ctx context.Context, key, uploadID string, parts []Part) error {
	_, core, _ := clients()
	if core == nil {
		return errors.New("storage disabled")
	}
	cp := make([]minio.CompletePart, len(parts))
	for i, p := range parts {
		cp[i] = minio.CompletePart{PartNumber: p.PartNumber, ETag: p.ETag}
	}
	_, err := core.CompleteMultipartUpload(ctx, Bucket(), key, uploadID, cp, minio.PutObjectOptions{})
	return err
}

func AbortMultipart(ctx context.Context, key, uploadID string) {
	_, core, _ := clients()
	if core == nil {
		return
	}
	if err := core.AbortMultipartUpload(ctx, Bucket(), key, uploadID); err != nil {
		log.Printf("[storage] abortMultipart: %v", err)
	}
}
