package realtime

import (
	"context"
	"crypto/tls"
	"encoding/binary"
	"errors"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"os"

	"github.com/gorilla/websocket"
	"github.com/quic-go/quic-go"
	"github.com/quic-go/quic-go/http3"
	webtransport "github.com/zishang520/webtransport-go"

	"vaultchat/backend-go/internal/ccwire"
	"vaultchat/backend-go/internal/httpx"
	"vaultchat/backend-go/internal/metrics"
)

const CCWireWebTransportPath = "/ccwire/wt/v1"

// StartCCWireWebTransport adds a separate UDP listener only on explicit opt-in.
// The current dependency and Rust wtransport 0.7.2 use draft-02 negotiation;
// the native CONNECT must include Sec-Webtransport-Http3-Draft02: 1.
func StartCCWireWebTransport(h *Hub) (io.Closer, error) {
	if os.Getenv("CCWIRE_WEBTRANSPORT") != "1" {
		return nil, nil
	}
	addr, certFile, keyFile := os.Getenv("CCWIRE_WT_ADDR"), os.Getenv("CCWIRE_WT_CERT"), os.Getenv("CCWIRE_WT_KEY")
	if h == nil || addr == "" || certFile == "" || keyFile == "" {
		return nil, errors.New("CCWIRE_WEBTRANSPORT requires hub, CCWIRE_WT_ADDR, CCWIRE_WT_CERT and CCWIRE_WT_KEY")
	}
	if _, err := loadCCWireCertificate(certFile, keyFile); err != nil {
		return nil, fmt.Errorf("ccwire WebTransport certificate: %w", err)
	}
	tlsConfig := &tls.Config{MinVersion: tls.VersionTLS13, GetCertificate: func(*tls.ClientHelloInfo) (*tls.Certificate, error) {
		// Read current files on new connections, so Certbot renewal needs no
		// listener restart and does not interrupt existing sessions.
		certificate, err := loadCCWireCertificate(certFile, keyFile)
		return &certificate, err
	}}
	server := newCCWireWebTransportServer(h, tlsConfig)
	packet, err := net.ListenPacket("udp", addr)
	if err != nil {
		return nil, err
	}
	go func() {
		defer packet.Close()
		if err := server.Serve(packet); err != nil && !errors.Is(err, http.ErrServerClosed) && !errors.Is(err, net.ErrClosed) {
			log.Printf("[ccwire] WebTransport listener stopped: %v", err)
		}
	}()
	log.Printf("[ccwire] WebTransport listening on UDP %s at %s", addr, CCWireWebTransportPath)
	return server, nil
}

func loadCCWireCertificate(certFile, keyFile string) (tls.Certificate, error) {
	if certFile != keyFile {
		return tls.LoadX509KeyPair(certFile, keyFile)
	}
	// An atomically replaced PEM bundle avoids reading a renewed certificate
	// with the old key during the interval between two separate file updates.
	bundle, err := os.ReadFile(certFile)
	if err != nil {
		return tls.Certificate{}, err
	}
	return tls.X509KeyPair(bundle, bundle)
}

func newCCWireWebTransportServer(h *Hub, tlsConfig *tls.Config) *webtransport.Server {
	server := &webtransport.Server{H3: http3.Server{
		TLSConfig: tlsConfig,
		QUICConfig: &quic.Config{
			MaxIdleTimeout: ccwireIdleTimeout,
			// One request stream plus one reliable CC-Wire stream. Other
			// stream types are not used for message delivery.
			MaxIncomingStreams: 2,
		},
		MaxHeaderBytes: 16 << 10,
	}}
	mux := http.NewServeMux()
	mux.HandleFunc(CCWireWebTransportPath, httpx.RequireAuth(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodConnect || r.Proto != "webtransport" || r.URL.RawQuery != "" {
			httpx.Err(w, http.StatusBadRequest, "invalid_webtransport_request")
			return
		}
		session, err := server.Upgrade(w, r)
		if err != nil {
			httpx.Err(w, http.StatusBadRequest, "webtransport_upgrade_failed")
			return
		}
		defer session.CloseWithError(0, "")
		ctx, cancel := context.WithTimeout(r.Context(), ccwireIdleTimeout)
		stream, err := session.AcceptStream(ctx)
		cancel()
		if err != nil {
			return
		}
		metrics.Inc("ccwire_webtransport_connect")
		defer metrics.Inc("ccwire_webtransport_disconnect")
		h.ccwireRun(r, &ccwireWebTransportConn{Stream: stream, session: session})
	}))
	server.H3.Handler = mux
	return server
}

type ccwireWebTransportConn struct {
	*webtransport.Stream
	session *webtransport.Session
}

func (c *ccwireWebTransportConn) Close() error { return c.session.CloseWithError(0, "") }

func (c *ccwireWebTransportConn) ReadMessage() (int, []byte, error) {
	raw, err := readCCWireStreamFrame(c.Stream)
	return websocket.BinaryMessage, raw, err
}

func (c *ccwireWebTransportConn) WriteMessage(_ int, raw []byte) error {
	n, err := c.Stream.Write(raw)
	if err == nil && n != len(raw) {
		return io.ErrShortWrite
	}
	return err
}

func readCCWireStreamFrame(reader io.Reader) ([]byte, error) {
	var header [ccwire.HeaderBytes]byte
	if _, err := io.ReadFull(reader, header[:]); err != nil {
		return nil, err
	}
	// Reuse framing validation BEFORE allocating from an untrusted length.
	if _, err := ccwire.Decode(header[:], ccwire.Options{}); err != nil && !errors.Is(err, ccwire.ErrIncomplete) {
		return nil, err
	}
	raw := make([]byte, ccwire.HeaderBytes+int(binary.BigEndian.Uint32(header[1:])))
	copy(raw, header[:])
	_, err := io.ReadFull(reader, raw[ccwire.HeaderBytes:])
	return raw, err
}

var _ ccwireConnection = (*ccwireWebTransportConn)(nil)
