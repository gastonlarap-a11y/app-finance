package mailsync

import (
	"errors"
	"fmt"

	"github.com/zalando/go-keyring"
)

// ErrSecretNotFound means the keychain has no password for the account.
var ErrSecretNotFound = errors.New("secret not found")

// SecretStore keeps mailbox passwords out of the database and prefs files.
type SecretStore interface {
	Set(key, secret string) error
	Get(key string) (string, error)
	Delete(key string) error
}

// Keychain stores secrets in the OS credential store (macOS Keychain,
// Windows Credential Manager, Secret Service on Linux) under one service name.
type Keychain struct{ service string }

func NewKeychain(service string) *Keychain { return &Keychain{service: service} }

func (k *Keychain) Set(key, secret string) error {
	if err := keyring.Set(k.service, key, secret); err != nil {
		return fmt.Errorf("saving to the keychain: %w", err)
	}
	return nil
}

func (k *Keychain) Get(key string) (string, error) {
	s, err := keyring.Get(k.service, key)
	if errors.Is(err, keyring.ErrNotFound) {
		return "", ErrSecretNotFound
	}
	if err != nil {
		return "", fmt.Errorf("reading the keychain: %w", err)
	}
	return s, nil
}

// Delete removes the secret; a missing one is not an error.
func (k *Keychain) Delete(key string) error {
	if err := keyring.Delete(k.service, key); err != nil && !errors.Is(err, keyring.ErrNotFound) {
		return fmt.Errorf("deleting from the keychain: %w", err)
	}
	return nil
}
