// Mirror of backend/finance/look.go: the icon and color keys a category, card
// or savings goal may store. Both sides read the same looks.json (raw import,
// like the engine's migrations), so they accept exactly the same keys.
import looksJson from '../../../../backend/finance/looks.json?raw'

interface LooksFile {
  colors: string[]
  icons: string[]
}

// The file ships with the build and backend/finance/look_test.go checks its
// shape, so the parse result is trusted as LooksFile.
const file = JSON.parse(looksJson) as LooksFile

export const LOOK_COLORS: readonly string[] = file.colors
export const LOOK_ICONS: readonly string[] = file.icons

const colors = new Set(file.colors)
const icons = new Set(file.icons)

// '' means automatic (the app picks from the name or id) and is always valid.
export function validColor(key: string): boolean {
  return key === '' || colors.has(key)
}

export function validIcon(key: string): boolean {
  return key === '' || icons.has(key)
}
