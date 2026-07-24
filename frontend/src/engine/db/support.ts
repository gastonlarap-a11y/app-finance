// OPFS feature probe, run before mounting the app on the web build. Safari in
// private browsing has no OPFS at all; without it there is no persistent local
// storage, so the app refuses to start rather than silently losing data.
export async function detectOpfsSupport(): Promise<boolean> {
  try {
    if (!('storage' in navigator) || typeof navigator.storage.getDirectory !== 'function') {
      return false
    }
    await navigator.storage.getDirectory()
    return true
  } catch {
    return false
  }
}
