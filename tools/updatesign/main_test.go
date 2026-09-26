package main

import (
	"crypto/ed25519"
	"crypto/sha256"
	"encoding/base64"
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

type keyPair struct{ priv, pub string }

func newKeyPair(t *testing.T, dir, name string) keyPair {
	t.Helper()
	kp := keyPair{priv: filepath.Join(dir, name+".key"), pub: filepath.Join(dir, name+".pub")}
	if err := run([]string{"keygen", "-key", kp.priv, "-pub", kp.pub}, os.Getenv, io.Discard); err != nil {
		t.Fatalf("keygen: %v", err)
	}
	return kp
}

func envWith(t *testing.T, keyFile string) func(string) string {
	t.Helper()
	data, err := os.ReadFile(keyFile)
	if err != nil {
		t.Fatal(err)
	}
	return func(name string) string {
		if name == keyEnv {
			return string(data)
		}
		return ""
	}
}

func writeArtifact(t *testing.T, dir, content string) string {
	t.Helper()
	path := filepath.Join(dir, "app-finance-darwin-universal.zip")
	if err := os.WriteFile(path, []byte(content), 0o600); err != nil {
		t.Fatal(err)
	}
	return path
}

func TestSignThenVerify(t *testing.T) {
	dir := t.TempDir()
	kp := newKeyPair(t, dir, "release")
	artifact := writeArtifact(t, dir, "update payload")

	if err := run([]string{"sign", "-pub", kp.pub, artifact}, envWith(t, kp.priv), io.Discard); err != nil {
		t.Fatalf("sign: %v", err)
	}
	if err := run([]string{"verify", "-pub", kp.pub, artifact}, os.Getenv, io.Discard); err != nil {
		t.Fatalf("verify: %v", err)
	}

	// The sidecar is what Wails' "ed25519" verifier checks: the raw signature
	// over the SHA-256 digest of the file.
	raw, err := os.ReadFile(artifact + sigSuffix)
	if err != nil {
		t.Fatal(err)
	}
	sig, err := base64.StdEncoding.DecodeString(strings.TrimSpace(string(raw)))
	if err != nil {
		t.Fatal(err)
	}
	pub, err := readPublic(kp.pub)
	if err != nil {
		t.Fatal(err)
	}
	digest := sha256.Sum256([]byte("update payload"))
	if !ed25519.Verify(pub, digest[:], sig) {
		t.Fatal("sidecar is not an Ed25519 signature over the SHA-256 digest")
	}
}

func TestVerifyRejects(t *testing.T) {
	dir := t.TempDir()
	kp := newKeyPair(t, dir, "release")
	other := newKeyPair(t, dir, "other")
	artifact := writeArtifact(t, dir, "update payload")
	if err := run([]string{"sign", "-pub", kp.pub, artifact}, envWith(t, kp.priv), io.Discard); err != nil {
		t.Fatalf("sign: %v", err)
	}

	tests := []struct {
		name   string
		mutate func(t *testing.T)
		pub    string
	}{
		{name: "another key", pub: other.pub},
		{name: "tampered artifact", pub: kp.pub, mutate: func(t *testing.T) { writeArtifact(t, dir, "evil payload") }},
		{name: "garbled signature", pub: kp.pub, mutate: func(t *testing.T) {
			if err := os.WriteFile(artifact+sigSuffix, []byte("not base64!"), 0o600); err != nil {
				t.Fatal(err)
			}
		}},
		{name: "missing signature", pub: kp.pub, mutate: func(t *testing.T) {
			if err := os.Remove(artifact + sigSuffix); err != nil {
				t.Fatal(err)
			}
		}},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if tt.mutate != nil {
				tt.mutate(t)
			}
			if err := run([]string{"verify", "-pub", tt.pub, artifact}, os.Getenv, io.Discard); err == nil {
				t.Fatal("verify accepted it")
			}
		})
	}
}

func TestSignRefuses(t *testing.T) {
	dir := t.TempDir()
	kp := newKeyPair(t, dir, "release")
	other := newKeyPair(t, dir, "other")
	artifact := writeArtifact(t, dir, "update payload")

	tests := []struct {
		name string
		env  func(string) string
		pub  string
		want string
	}{
		{name: "no secret", env: func(string) string { return "" }, pub: kp.pub, want: "is empty"},
		{name: "secret for another public key", env: envWith(t, other.priv), pub: kp.pub, want: "does not match"},
		{name: "not a private key", env: func(string) string { return "hello" }, pub: kp.pub, want: "PEM"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			err := run([]string{"sign", "-pub", tt.pub, artifact}, tt.env, io.Discard)
			if err == nil || !strings.Contains(err.Error(), tt.want) {
				t.Fatalf("sign error = %v, want it to mention %q", err, tt.want)
			}
			if _, statErr := os.Stat(artifact + sigSuffix); !os.IsNotExist(statErr) {
				t.Fatal("a refused sign left a signature behind")
			}
		})
	}
}

func TestKeygenNeverOverwrites(t *testing.T) {
	dir := t.TempDir()
	kp := newKeyPair(t, dir, "release")
	before, err := os.ReadFile(kp.priv)
	if err != nil {
		t.Fatal(err)
	}
	if err := run([]string{"keygen", "-key", kp.priv, "-pub", filepath.Join(dir, "new.pub")}, os.Getenv, io.Discard); err == nil {
		t.Fatal("keygen replaced an existing private key")
	}
	after, err := os.ReadFile(kp.priv)
	if err != nil {
		t.Fatal(err)
	}
	if string(before) != string(after) {
		t.Fatal("the existing private key changed")
	}

	// An existing public key file aborts too, without leaving a stray private key.
	fresh := filepath.Join(dir, "fresh.key")
	if err := run([]string{"keygen", "-key", fresh, "-pub", kp.pub}, os.Getenv, io.Discard); err == nil {
		t.Fatal("keygen replaced an existing public key")
	}
	if _, err := os.Stat(fresh); !os.IsNotExist(err) {
		t.Fatal("keygen left an orphan private key")
	}

	info, err := os.Stat(kp.priv)
	if err != nil {
		t.Fatal(err)
	}
	if perm := info.Mode().Perm(); perm != 0o600 {
		t.Fatalf("private key mode = %o, want 600", perm)
	}
}
