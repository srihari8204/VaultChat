// Run from vaultchat-backend-go: go run ../scripts/http3-probe.go
// Uses the backend's existing quic-go dependency; never falls back to TCP.
package main

import (
	"context"
	"crypto/tls"
	"flag"
	"fmt"
	"net/http"
	"os"
	"time"

	"github.com/quic-go/quic-go"
	"github.com/quic-go/quic-go/http3"
)

func main() {
	endpoint := flag.String("url", "https://api.corefinite.com/health", "HTTPS endpoint to check")
	connect := flag.String("connect", "", "optional UDP host:port override; preserves Host and TLS verification")
	flag.Parse()
	if err := probe(*endpoint, *connect); err != nil {
		fmt.Fprintln(os.Stderr, "HTTP/3 probe failed:", err)
		os.Exit(1)
	}
}

func probe(endpoint, connect string) error {
	transport := &http3.Transport{}
	defer transport.Close()
	if connect != "" {
		transport.Dial = func(ctx context.Context, _ string, tlsConfig *tls.Config, config *quic.Config) (*quic.Conn, error) {
			return quic.DialAddr(ctx, connect, tlsConfig, config)
		}
	}
	client := &http.Client{
		Transport: transport,
		Timeout:   15 * time.Second,
		CheckRedirect: func(*http.Request, []*http.Request) error {
			return http.ErrUseLastResponse
		},
	}
	response, err := client.Get(endpoint)
	if err != nil {
		return err
	}
	defer response.Body.Close()
	if response.ProtoMajor != 3 || response.TLS == nil || response.TLS.NegotiatedProtocol != "h3" {
		return fmt.Errorf("expected HTTP/3 with h3 TLS negotiation; got %s", response.Proto)
	}
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return fmt.Errorf("HTTP/3 negotiated but endpoint returned %s", response.Status)
	}
	certificate := response.TLS.PeerCertificates[0]
	fmt.Printf("PASS protocol=%s alpn=%s status=%d certificate_serial=%s expires=%s\n",
		response.Proto, response.TLS.NegotiatedProtocol, response.StatusCode,
		certificate.SerialNumber.Text(16), certificate.NotAfter.UTC().Format(time.RFC3339))
	return nil
}
