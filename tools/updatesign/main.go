// Command updatesign creates the Ed25519 key pair that signs in-app updates
// and signs/verifies release artifacts with it. Standard library only, so the
// release workflow can run it without fetching any third-party code.
//
// The app (backend/updates) embeds the public key and, through Wails'
// updater, accepts an update only when <artifact>.sig verifies over the
// SHA-256 digest of the downloaded file. Same scheme as Sparkle's EdDSA and
// Tauri's updater signatures: raw Ed25519, public key pinned in the binary.
//
//	updatesign keygen -key <private.pem> -pub <public.pem>
//	UPDATE_SIGNING_KEY="$(cat private.pem)" updatesign sign -pub <public.pem> FILE...
//	updatesign verify -pub <public.pem> FILE...
//
// The private key is read from the UPDATE_SIGNING_KEY environment variable,
// never from a flag (flags show up in process listings and shell history).
package main

import (
	"crypto/ed25519"
	"crypto/rand"
	"crypto/sha256"
	"crypto/x509"
	"encoding/base64"
	"encoding/pem"
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"strings"
)

// keyEnv names the environment variable holding the PEM private key.
const keyEnv = "UPDATE_SIGNING_KEY"

// sigSuffix is the sidecar extension backend/updates looks for next to the artifact.
const sigSuffix = ".sig"

func main() {
	if err := run(os.Args[1:], os.Getenv, os.Stdout); err != nil {
		fmt.Fprintln(os.Stderr, "updatesign:", err)
		os.Exit(1)
	}
}

func run(args []string, getenv func(string) string, out io.Writer) error {
	if len(args) == 0 {
		return errors.New("usage: updatesign keygen|sign|verify [flags] [FILE...]")
	}
	fs := flag.NewFlagSet(args[0], flag.ContinueOnError)
	pubPath := fs.String("pub", "", "public key (PEM, PKIX)")
	keyPath := fs.String("key", "", "keygen only: where to write the private key (PEM, PKCS#8)")
	if err := fs.Parse(args[1:]); err != nil {
		return err
	}
	if *pubPath == "" {
		return errors.New("-pub is required")
	}
	switch args[0] {
	case "keygen":
		if *keyPath == "" {
			return errors.New("keygen needs -key")
		}
		return keygen(*keyPath, *pubPath, out)
	case "sign":
		return signFiles(getenv(keyEnv), *pubPath, fs.Args(), out)
	case "verify":
		return verifyFiles(*pubPath, fs.Args(), out)
	default:
		return fmt.Errorf("unknown command %q", args[0])
	}
}

// keygen writes a new key pair. It never overwrites an existing file: replacing
// the key by accident would strand every installed copy of the app.
func keygen(keyPath, pubPath string, out io.Writer) error {
	pub, priv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		return fmt.Errorf("generate key: %w", err)
	}
	privDER, err := x509.MarshalPKCS8PrivateKey(priv)
	if err != nil {
		return fmt.Errorf("encode private key: %w", err)
	}
	pubDER, err := x509.MarshalPKIXPublicKey(pub)
	if err != nil {
		return fmt.Errorf("encode public key: %w", err)
	}
	if err := writeNew(keyPath, pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: privDER}), 0o600); err != nil {
		return err
	}
	if err := writeNew(pubPath, pem.EncodeToMemory(&pem.Block{Type: "PUBLIC KEY", Bytes: pubDER}), 0o644); err != nil {
		// Without its public half the new private key is useless; drop it.
		if rmErr := os.Remove(keyPath); rmErr != nil {
			return errors.Join(err, fmt.Errorf("remove %s: %w", keyPath, rmErr))
		}
		return err
	}
	_, err = fmt.Fprintf(out, "private key: %s (keep it secret, back it up)\npublic key:  %s\n", keyPath, pubPath)
	return err
}

func writeNew(path string, data []byte, perm os.FileMode) error {
	f, err := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_EXCL, perm)
	if err != nil {
		return fmt.Errorf("create %s: %w", path, err)
	}
	if _, err := f.Write(data); err != nil {
		return errors.Join(fmt.Errorf("write %s: %w", path, err), f.Close())
	}
	if err := f.Close(); err != nil {
		return fmt.Errorf("close %s: %w", path, err)
	}
	return nil
}

// signFiles writes FILE.sig for each file and checks it against the committed
// public key, so a secret that does not match the key the app embeds fails the
// release instead of shipping updates nobody can install.
func signFiles(privPEM, pubPath string, files []string, out io.Writer) error {
	if strings.TrimSpace(privPEM) == "" {
		return fmt.Errorf("%s is empty: set it to the PEM private key", keyEnv)
	}
	if len(files) == 0 {
		return errors.New("no files to sign")
	}
	priv, err := parsePrivate([]byte(privPEM))
	if err != nil {
		return err
	}
	pub, err := readPublic(pubPath)
	if err != nil {
		return err
	}
	if !pub.Equal(priv.Public()) {
		return fmt.Errorf("%s does not match the public key in %s", keyEnv, pubPath)
	}
	for _, file := range files {
		digest, err := fileDigest(file)
		if err != nil {
			return err
		}
		sig := ed25519.Sign(priv, digest)
		if !ed25519.Verify(pub, digest, sig) {
			return fmt.Errorf("%s: signature does not verify", file)
		}
		if err := os.WriteFile(file+sigSuffix, []byte(base64.StdEncoding.EncodeToString(sig)+"\n"), 0o644); err != nil {
			return fmt.Errorf("write signature: %w", err)
		}
		if _, err := fmt.Fprintf(out, "signed %s\n", file); err != nil {
			return err
		}
	}
	return nil
}

// verifyFiles checks FILE.sig for each file, as the app does after downloading it.
func verifyFiles(pubPath string, files []string, out io.Writer) error {
	if len(files) == 0 {
		return errors.New("no files to verify")
	}
	pub, err := readPublic(pubPath)
	if err != nil {
		return err
	}
	for _, file := range files {
		digest, err := fileDigest(file)
		if err != nil {
			return err
		}
		raw, err := os.ReadFile(file + sigSuffix)
		if err != nil {
			return fmt.Errorf("read signature: %w", err)
		}
		sig, err := base64.StdEncoding.DecodeString(strings.TrimSpace(string(raw)))
		if err != nil || len(sig) != ed25519.SignatureSize {
			return fmt.Errorf("%s%s: malformed signature", file, sigSuffix)
		}
		if !ed25519.Verify(pub, digest, sig) {
			return fmt.Errorf("%s: signature does not verify", file)
		}
		if _, err := fmt.Fprintf(out, "ok %s\n", file); err != nil {
			return err
		}
	}
	return nil
}

// fileDigest is the SHA-256 of the file: what Wails' updater hashes while
// downloading and what the "ed25519" verifier checks the signature over.
func fileDigest(path string) ([]byte, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, fmt.Errorf("open %s: %w", path, err)
	}
	defer f.Close() // read-only handle: nothing to flush
	h := sha256.New()
	if _, err := io.Copy(h, f); err != nil {
		return nil, fmt.Errorf("hash %s: %w", path, err)
	}
	return h.Sum(nil), nil
}

func parsePrivate(data []byte) (ed25519.PrivateKey, error) {
	block, _ := pem.Decode(data)
	if block == nil || block.Type != "PRIVATE KEY" {
		return nil, errors.New("private key: not a PEM \"PRIVATE KEY\" block")
	}
	key, err := x509.ParsePKCS8PrivateKey(block.Bytes)
	if err != nil {
		return nil, fmt.Errorf("private key: %w", err)
	}
	priv, ok := key.(ed25519.PrivateKey)
	if !ok {
		return nil, fmt.Errorf("private key: %T is not Ed25519", key)
	}
	return priv, nil
}

func readPublic(path string) (ed25519.PublicKey, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("read public key: %w", err)
	}
	block, _ := pem.Decode(data)
	if block == nil || block.Type != "PUBLIC KEY" {
		return nil, fmt.Errorf("%s: not a PEM \"PUBLIC KEY\" block", path)
	}
	key, err := x509.ParsePKIXPublicKey(block.Bytes)
	if err != nil {
		return nil, fmt.Errorf("%s: %w", path, err)
	}
	pub, ok := key.(ed25519.PublicKey)
	if !ok {
		return nil, fmt.Errorf("%s: %T is not Ed25519", path, key)
	}
	return pub, nil
}
