package updates

import (
	"errors"
	"regexp"
)

// configVersion matches `  version: "X.Y.Z"` under `info:` in build/config.yml —
// the same line .github/workflows/release.yml reads to check the release tag,
// so the running app and its release can never disagree about the version.
var configVersion = regexp.MustCompile(`(?m)^  version: "([0-9][^"]*)"`)

// VersionFromConfig extracts the app version from the contents of
// build/config.yml (embedded into the binary by main.go).
func VersionFromConfig(config []byte) (string, error) {
	m := configVersion.FindSubmatch(config)
	if m == nil {
		return "", errors.New("info.version not found in build/config.yml")
	}
	return string(m[1]), nil
}
