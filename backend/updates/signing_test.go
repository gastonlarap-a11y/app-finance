package updates

import (
	"context"
	"crypto/ed25519"
	"encoding/base64"
	"errors"
	"io"
	"net/http"
	"strings"
	"testing"

	"github.com/wailsapp/wails/v3/pkg/updater"
)

const assetURL = "https://github.com/owner/repo/releases/download/v0.4.0/app-finance-darwin-universal.zip"

// fakeFeed stands in for Wails' GitHub provider.
type fakeFeed struct {
	rel *updater.Release
	err error
}

func (f *fakeFeed) Name() string { return "github" }
func (f *fakeFeed) Check(context.Context, updater.CheckRequest) (*updater.Release, error) {
	return f.rel, f.err
}
func (f *fakeFeed) Download(context.Context, *updater.Release, io.Writer, func(int64, int64)) error {
	return nil
}

// roundTrip answers every request in memory (the sandbox cannot bind ports).
type roundTrip func(*http.Request) (*http.Response, error)

func (f roundTrip) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }

func respond(status int, body string) roundTrip {
	return func(*http.Request) (*http.Response, error) {
		return &http.Response{StatusCode: status, Body: io.NopCloser(strings.NewReader(body)), Header: http.Header{}}, nil
	}
}

// fromFeed is a release as Wails' GitHub provider returns it: digest from
// SHA256SUMS.txt, no signature, the download URL in Metadata.
func fromFeed() *updater.Release {
	rel := verified("0.4.0")
	rel.Verification.Signature, rel.Verification.SignatureAlgo = nil, ""
	rel.Metadata = map[string]any{assetURLKey: assetURL}
	return rel
}

func TestEmbeddedSigningKeyParses(t *testing.T) {
	pub, err := parseSigningKey(signingPublicKeyPEM)
	if err != nil {
		t.Fatalf("update_signing.pub: %v", err)
	}
	if len(pub) != ed25519.PublicKeySize {
		t.Fatalf("key size = %d", len(pub))
	}
	if _, err := parseSigningKey([]byte("not a key")); err == nil {
		t.Fatal("parsed garbage as a key")
	}
}

func TestSignedProviderAttachesTheSignature(t *testing.T) {
	sig := ed25519.Sign(testKey, fromFeed().Verification.Digest)
	var fetched string
	client := &http.Client{Transport: roundTrip(func(r *http.Request) (*http.Response, error) {
		fetched = r.URL.String()
		return respond(http.StatusOK, base64.StdEncoding.EncodeToString(sig)+"\n")(r)
	})}
	p := newSignedProvider(&fakeFeed{rel: fromFeed()}, client)

	rel, err := p.Check(t.Context(), updater.CheckRequest{})
	if err != nil {
		t.Fatalf("Check: %v", err)
	}
	if fetched != assetURL+".sig" {
		t.Fatalf("fetched %q, want the artifact URL + .sig", fetched)
	}
	if rel.Verification.SignatureAlgo != sigAlgo || !ed25519.Verify(testKey.Public().(ed25519.PublicKey), rel.Verification.Digest, rel.Verification.Signature) {
		t.Fatalf("verification = %+v, want the fetched ed25519 signature", rel.Verification)
	}
	if problem := signatureProblem(rel, testKey.Public().(ed25519.PublicKey)); problem != "" {
		t.Fatalf("a correctly signed release was refused: %s", problem)
	}
}

func TestSignedProviderEdgeCases(t *testing.T) {
	noFetch := roundTrip(func(r *http.Request) (*http.Response, error) {
		t.Errorf("unexpected request to %s", r.URL)
		return nil, errors.New("no network in this case")
	})
	tests := []struct {
		name      string
		feed      *fakeFeed
		transport http.RoundTripper
		wantErr   bool
		unsigned  bool // the release comes back without a signature (Service refuses it)
	}{
		{name: "up to date", feed: &fakeFeed{}, transport: noFetch},
		{name: "feed error", feed: &fakeFeed{err: errors.New("offline")}, transport: noFetch, wantErr: true},
		{name: "no checksum: nothing to sign", feed: &fakeFeed{rel: func() *updater.Release {
			rel := fromFeed()
			rel.Verification = nil
			return rel
		}()}, transport: noFetch},
		{name: "no .sig asset", feed: &fakeFeed{rel: fromFeed()}, transport: respond(http.StatusNotFound, "Not Found"), unsigned: true},
		{name: "server error", feed: &fakeFeed{rel: fromFeed()}, transport: respond(http.StatusBadGateway, ""), wantErr: true},
		{name: "malformed signature", feed: &fakeFeed{rel: fromFeed()}, transport: respond(http.StatusOK, "<html>"), wantErr: true},
		{name: "truncated signature", feed: &fakeFeed{rel: fromFeed()}, transport: respond(http.StatusOK, base64.StdEncoding.EncodeToString([]byte("short"))), wantErr: true},
		{name: "artifact URL not https", feed: &fakeFeed{rel: func() *updater.Release {
			rel := fromFeed()
			rel.Metadata[assetURLKey] = "http://example.com/app.zip"
			return rel
		}()}, transport: noFetch, wantErr: true},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			p := newSignedProvider(tt.feed, &http.Client{Transport: tt.transport})
			rel, err := p.Check(t.Context(), updater.CheckRequest{})
			if (err != nil) != tt.wantErr {
				t.Fatalf("err = %v, wantErr %v", err, tt.wantErr)
			}
			if tt.unsigned {
				if rel == nil || len(rel.Verification.Signature) != 0 {
					t.Fatalf("release = %+v, want it back unsigned", rel)
				}
				if problem := signatureProblem(rel, testKey.Public().(ed25519.PublicKey)); !strings.Contains(problem, "no está firmada") {
					t.Fatalf("unsigned release problem = %q", problem)
				}
			}
		})
	}
}
