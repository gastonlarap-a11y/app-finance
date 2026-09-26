package updates

import (
	"context"
	"crypto/ed25519"
	"crypto/x509"
	_ "embed"
	"encoding/base64"
	"encoding/pem"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"

	"github.com/wailsapp/wails/v3/pkg/updater"
)

// Update signing: the release workflow signs each in-app update artifact with
// an Ed25519 key (tools/updatesign) and publishes <artifact>.sig next to it.
// The public half is pinned here, at build time: a compromised release feed
// can replace artifacts and SHA256SUMS.txt, but not produce a signature this
// key accepts. Same model as Sparkle's EdDSA and Tauri's updater signatures.

// signingPublicKeyPEM is the PKIX public key the release secret
// UPDATE_SIGNING_KEY pairs with (created with `updatesign keygen`).
//
//go:embed update_signing.pub
var signingPublicKeyPEM []byte

const (
	// sigAlgo is Wails' raw Ed25519 verifier: the signature covers the
	// SHA-256 digest of the artifact.
	sigAlgo      = "ed25519"
	sigSuffix    = ".sig"
	sigMaxBytes  = 1 << 10
	sigFetchWait = 30 * time.Second
	// assetURLKey is where Wails' GitHub provider stores the artifact's
	// browser_download_url; the signature sits at the same URL + ".sig".
	assetURLKey = "github.asset.url"
)

// parseSigningKey decodes the embedded PEM public key.
func parseSigningKey(data []byte) (ed25519.PublicKey, error) {
	block, _ := pem.Decode(data)
	if block == nil || block.Type != "PUBLIC KEY" {
		return nil, errors.New("update signing key: not a PEM \"PUBLIC KEY\" block")
	}
	key, err := x509.ParsePKIXPublicKey(block.Bytes)
	if err != nil {
		return nil, fmt.Errorf("update signing key: %w", err)
	}
	pub, ok := key.(ed25519.PublicKey)
	if !ok {
		return nil, fmt.Errorf("update signing key: %T is not Ed25519", key)
	}
	return pub, nil
}

// signatureProblem explains why rel must not be installed, or returns "" when
// its signature verifies under pub. Checked on every release a check finds;
// Wails' updater checks it again over the digest of the bytes it downloads.
func signatureProblem(rel *updater.Release, pub ed25519.PublicKey) string {
	v := rel.Verification
	switch {
	case v == nil || len(v.Digest) == 0:
		return fmt.Sprintf("La versión %s no publica el checksum de su descarga (%s): por seguridad no se instalará.", rel.Version, checksumAsset)
	case len(v.Signature) == 0:
		return fmt.Sprintf("La versión %s no está firmada: por seguridad no se instalará.", rel.Version)
	case v.SignatureAlgo != sigAlgo || !ed25519.Verify(pub, v.Digest, v.Signature):
		return fmt.Sprintf("La firma de la versión %s no es válida: por seguridad no se instalará.", rel.Version)
	}
	return ""
}

// signedProvider decorates Wails' GitHub provider, which fills the digest from
// SHA256SUMS.txt but never loads signatures: it fetches <artifact>.sig and
// attaches it to the release. It does not judge the signature — the Service
// does (signatureProblem), so an unsigned or badly signed release is reported
// to the user instead of failing as an opaque check error.
type signedProvider struct {
	updater.Provider
	client *http.Client
}

func newSignedProvider(inner updater.Provider, client *http.Client) *signedProvider {
	if client == nil {
		client = &http.Client{Timeout: sigFetchWait}
	}
	return &signedProvider{Provider: inner, client: client}
}

func (p *signedProvider) Check(ctx context.Context, req updater.CheckRequest) (*updater.Release, error) {
	rel, err := p.Provider.Check(ctx, req)
	if err != nil || rel == nil || rel.Verification == nil || len(rel.Verification.Digest) == 0 {
		return rel, err
	}
	assetURL, _ := rel.Metadata[assetURLKey].(string)
	if !strings.HasPrefix(assetURL, "https://") {
		return nil, fmt.Errorf("release %s: unexpected artifact URL %q", rel.Version, assetURL)
	}
	sig, err := p.fetchSignature(ctx, assetURL+sigSuffix)
	if err != nil {
		return nil, fmt.Errorf("release %s: %w", rel.Version, err)
	}
	if sig != nil {
		rel.Verification.SignatureAlgo = sigAlgo
		rel.Verification.Signature = sig
	}
	return rel, nil
}

// fetchSignature downloads a base64 Ed25519 signature; (nil, nil) means the
// release publishes none.
func (p *signedProvider) fetchSignature(ctx context.Context, url string) ([]byte, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return nil, fmt.Errorf("signature request: %w", err)
	}
	resp, err := p.client.Do(req)
	if err != nil {
		return nil, fmt.Errorf("download signature: %w", err)
	}
	defer resp.Body.Close() // read-only response
	if resp.StatusCode == http.StatusNotFound {
		return nil, nil
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return nil, fmt.Errorf("download signature: HTTP %d", resp.StatusCode)
	}
	body, err := io.ReadAll(io.LimitReader(resp.Body, sigMaxBytes))
	if err != nil {
		return nil, fmt.Errorf("download signature: %w", err)
	}
	sig, err := base64.StdEncoding.DecodeString(strings.TrimSpace(string(body)))
	if err != nil || len(sig) != ed25519.SignatureSize {
		return nil, errors.New("malformed update signature")
	}
	return sig, nil
}
