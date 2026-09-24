package updates

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

// installTarget is what the updater replaces: the .app bundle on macOS, the
// executable itself elsewhere.
func installTarget(goos, exe string) string {
	if goos == "darwin" {
		if i := strings.Index(exe, ".app/"); i >= 0 {
			return exe[:i+len(".app")]
		}
	}
	return exe
}

// installBlocker explains why this copy of the app cannot replace itself, or
// returns "" when it can. Checked before offering "Actualizar" so an update
// never fails half-way:
//   - macOS runs apps opened straight from a download under App Translocation
//     (a read-only random path): the bundle must be moved to Aplicaciones;
//   - a development build (wails3 dev) must not be replaced by a release;
//   - the updater writes a backup next to the target and renames the new
//     version into place, so the target's folder must be writable (not a
//     mounted .dmg, not Program Files without admin rights).
func installBlocker(goos, exe string) string {
	target := installTarget(goos, exe)
	if strings.Contains(target, "/AppTranslocation/") {
		return "macOS está abriendo la app desde una ubicación temporal. Muévela a la carpeta Aplicaciones y ábrela desde ahí para poder actualizar."
	}
	if strings.HasSuffix(target, ".dev.app") {
		return "Es una compilación de desarrollo: las actualizaciones se instalan en la app empaquetada."
	}
	dir := filepath.Dir(target)
	probe, err := os.CreateTemp(dir, ".app-finance-update-check-*")
	if err != nil {
		return fmt.Sprintf("No se puede escribir en %s, donde está instalada la app. Instálala en una carpeta de tu usuario (en Mac, Aplicaciones) para poder actualizar.", dir)
	}
	name := probe.Name()
	_ = probe.Close()   // empty probe file: nothing to flush
	_ = os.Remove(name) // best-effort: a leftover empty probe is harmless
	return ""
}
