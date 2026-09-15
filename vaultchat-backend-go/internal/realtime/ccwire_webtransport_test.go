package realtime

import (
	"bytes"
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"encoding/json"
	"encoding/pem"
	"errors"
	"io"
	"math/big"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/golang-jwt/jwt/v5"
	webtransport "github.com/zishang520/webtransport-go"

	"vaultchat/backend-go/internal/ccwire"
)

func TestCCWireWebTransportOptIn(t *testing.T) {
	t.Setenv("CCWIRE_WEBTRANSPORT", "")
	if closer, err := StartCCWireWebTransport(nil); closer != nil || err != nil {
		t.Fatalf("disabled listener allocated resources: %v %v", closer, err)
	}
	t.Setenv("CCWIRE_WEBTRANSPORT", "1")
	t.Setenv("CCWIRE_WT_ADDR", "")
	if _, err := StartCCWireWebTransport(&Hub{}); err == nil {
		t.Fatal("enabled listener accepted missing configuration")
	}
}

func TestCCWireWebTransportCertificateBundle(t *testing.T) {
	fixture := httptest.NewTLSServer(http.NotFoundHandler())
	fixture.Close()
	certificate := fixture.TLS.Certificates[0]
	key, err := x509.MarshalPKCS8PrivateKey(certificate.PrivateKey)
	if err != nil {
		t.Fatal(err)
	}
	bundle := pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: certificate.Certificate[0]})
	bundle = append(bundle, pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: key})...)
	path := filepath.Join(t.TempDir(), "tls.pem")
	if err := os.WriteFile(path, bundle, 0600); err != nil {
		t.Fatal(err)
	}
	if _, err := loadCCWireCertificate(path, path); err != nil {
		t.Fatalf("combined certificate/key bundle rejected: %v", err)
	}
	if err := os.WriteFile(path, []byte("invalid replacement"), 0600); err != nil {
		t.Fatal(err)
	}
	if _, err := loadCCWireCertificate(path, path); err == nil {
		t.Fatal("loader reused stale credentials instead of validating the replacement")
	}
}

func TestCCWireWebTransportFrameBounds(t *testing.T) {
	valid, _ := ccwire.Encode([]byte("protobuf"), ccwire.Options{})
	reader := bytes.NewReader(append(append([]byte{}, valid...), valid...))
	for range 2 {
		raw, err := readCCWireStreamFrame(reader)
		if err != nil || !bytes.Equal(raw, valid) {
			t.Fatalf("adjacent frames lost their boundaries: %x %v", raw, err)
		}
	}
	for _, test := range []struct {
		raw []byte
		err error
	}{
		{[]byte{2, 0, 0, 0, 0}, ccwire.ErrBadVersion},
		{[]byte{1, 0xff, 0xff, 0xff, 0xff}, ccwire.ErrLengthOverMax},
		{[]byte{1, 0, 0}, io.ErrUnexpectedEOF},
		{[]byte{1, 0, 0, 0, 2, 1}, io.ErrUnexpectedEOF},
	} {
		if _, err := readCCWireStreamFrame(bytes.NewReader(test.raw)); !errors.Is(err, test.err) {
			t.Fatalf("invalid frame %x: got %v, want %v", test.raw, err, test.err)
		}
	}
}

func startWebTransportTestServer(t *testing.T) (string, *tls.Config, string, []byte) {
	t.Helper()
	t.Setenv("JWT_SECRET", "ccwire-webtransport-local-test-only")
	token, err := jwt.NewWithClaims(jwt.SigningMethodHS256, jwt.MapClaims{
		"sub": "wt-test-user", "exp": time.Now().Add(20 * time.Minute).Unix(),
	}).SignedString([]byte(os.Getenv("JWT_SECRET")))
	if err != nil {
		t.Fatal(err)
	}
	certificate, root, caPEM := webTransportTestIdentity(t)
	server := newCCWireWebTransportServer(&Hub{}, &tls.Config{Certificates: []tls.Certificate{certificate}, MinVersion: tls.VersionTLS13})
	packet, err := net.ListenPacket("udp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	go func() { _ = server.Serve(packet) }()
	t.Cleanup(func() { _ = server.Close(); _ = packet.Close() })
	return "https://" + packet.LocalAddr().String() + CCWireWebTransportPath,
		&tls.Config{RootCAs: root, MinVersion: tls.VersionTLS13}, token, caPEM
}

func webTransportTestIdentity(t *testing.T) (tls.Certificate, *x509.CertPool, []byte) {
	t.Helper()
	caKey, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	ca := &x509.Certificate{SerialNumber: big.NewInt(1), NotBefore: time.Now().Add(-time.Hour),
		NotAfter: time.Now().Add(time.Hour), IsCA: true, BasicConstraintsValid: true,
		KeyUsage: x509.KeyUsageCertSign | x509.KeyUsageDigitalSignature}
	caDER, err := x509.CreateCertificate(rand.Reader, ca, ca, &caKey.PublicKey, caKey)
	if err != nil {
		t.Fatal(err)
	}
	leafKey, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	// A real end-entity leaf is required by rustls; httptest's built-in
	// certificate is CA:true and Go accepts it as a leaf more leniently.
	leaf := &x509.Certificate{SerialNumber: big.NewInt(2), NotBefore: ca.NotBefore, NotAfter: ca.NotAfter,
		BasicConstraintsValid: true, KeyUsage: x509.KeyUsageDigitalSignature,
		ExtKeyUsage: []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth}, IPAddresses: []net.IP{net.ParseIP("127.0.0.1")}}
	leafDER, err := x509.CreateCertificate(rand.Reader, leaf, ca, &leafKey.PublicKey, caKey)
	if err != nil {
		t.Fatal(err)
	}
	keyDER, err := x509.MarshalPKCS8PrivateKey(leafKey)
	if err != nil {
		t.Fatal(err)
	}
	caPEM := pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: caDER})
	chain := append(pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: leafDER}), caPEM...)
	certificate, err := tls.X509KeyPair(chain, pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: keyDER}))
	if err != nil {
		t.Fatal(err)
	}
	root := x509.NewCertPool()
	root.AppendCertsFromPEM(caPEM)
	return certificate, root, caPEM
}

func TestCCWireWebTransportAuthenticatedSession(t *testing.T) {
	endpoint, tlsConfig, token, _ := startWebTransportTestServer(t)
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	dialer := &webtransport.Dialer{TLSClientConfig: tlsConfig}
	defer dialer.Close()
	for _, headers := range []http.Header{nil, {"Authorization": {"Bearer invalid"}}} {
		response, _, err := dialer.Dial(ctx, endpoint, headers)
		if err == nil || response == nil || response.StatusCode != http.StatusUnauthorized {
			t.Fatalf("unauthenticated CONNECT was not refused: response=%v err=%v", response, err)
		}
	}
	_, session, err := dialer.Dial(ctx, endpoint, http.Header{"Authorization": {"Bearer " + token}})
	if err != nil {
		t.Fatal(err)
	}
	defer session.CloseWithError(0, "")
	stream, err := session.OpenStreamSync(ctx)
	if err != nil {
		t.Fatal(err)
	}
	_ = stream.SetDeadline(time.Now().Add(5 * time.Second))
	helloFrame := frame(t, ccwire.Message{TrafficClass: ccwire.TrafficClassControl, BodyField: ccwire.BodyClientHello})
	pingFrame := frame(t, ccwire.Message{TrafficClass: ccwire.TrafficClassControl, BodyField: ccwire.BodyPing, Body: []byte{8, 42}})
	// Split a header, then pipeline two frames over the reliable byte stream.
	if _, err := stream.Write(helloFrame[:2]); err != nil {
		t.Fatal(err)
	}
	if _, err := stream.Write(append(helloFrame[2:], pingFrame...)); err != nil {
		t.Fatal(err)
	}
	for _, expected := range []uint32{ccwire.BodyServerHello, ccwire.BodyPong} {
		raw, err := readCCWireStreamFrame(stream)
		if err != nil {
			t.Fatal(err)
		}
		framed, err := ccwire.Decode(raw, ccwire.Options{Strict: true})
		if err != nil {
			t.Fatal(err)
		}
		message, err := ccwire.DecodeMessage(framed.Payload, ccwire.DefaultLimits(), 0, 0)
		if err != nil || message.BodyField != expected {
			t.Fatalf("shared CCWire handler response: body=%d err=%v", message.BodyField, err)
		}
	}
}

// Optional fixture for the pinned Rust client interoperability check. This
// creates only a short-lived local test identity, never production credentials.
func TestCCWireWebTransportInteropServer(t *testing.T) {
	dir := os.Getenv("CCWIRE_WT_INTEROP_DIR")
	if dir == "" {
		t.Skip("set CCWIRE_WT_INTEROP_DIR for the Rust interoperability fixture")
	}
	endpoint, _, token, ca := startWebTransportTestServer(t)
	if err := os.WriteFile(filepath.Join(dir, "ca.pem"), ca, 0600); err != nil {
		t.Fatal(err)
	}
	data, _ := json.Marshal(map[string]string{"url": endpoint, "token": token, "ca": filepath.Join(dir, "ca.pem")})
	if err := os.WriteFile(filepath.Join(dir, "fixture.json"), data, 0600); err != nil {
		t.Fatal(err)
	}
	t.Log("local Rust interoperability fixture ready")
	deadline := time.NewTimer(15 * time.Minute)
	defer deadline.Stop()
	tick := time.NewTicker(100 * time.Millisecond)
	defer tick.Stop()
	for {
		select {
		case <-deadline.C:
			t.Fatal("Rust interoperability fixture timed out")
		case <-tick.C:
			if _, err := os.Stat(filepath.Join(dir, "done")); err == nil {
				return
			}
		}
	}
}
