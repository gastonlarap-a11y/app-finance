// File hand-off that works inside an installed iPadOS PWA: standalone web apps
// have no browser download UI, so prefer the native Share Sheet (Save to
// Files, AirDrop…) and fall back to a download link in regular browser tabs.
export async function shareOrDownload(blob: Blob, filename: string): Promise<void> {
  const file = new File([blob], filename, { type: blob.type })
  if (typeof navigator.canShare === 'function' && navigator.canShare({ files: [file] })) {
    try {
      await navigator.share({ files: [file], title: filename })
      return
    } catch (err) {
      // User dismissed the Share Sheet — not an error.
      if (err instanceof DOMException && err.name === 'AbortError') return
      throw err
    }
  }
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  URL.revokeObjectURL(url)
}

export function backupFilename(): string {
  const d = new Date()
  const pad = (n: number) => String(n).padStart(2, '0')
  return `app-finance-${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}.sqlite`
}
