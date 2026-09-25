// File hand-off that works inside an installed iPadOS PWA: standalone web apps
// have no browser download UI, so prefer the native Share Sheet (Save to
// Files, AirDrop…) and fall back to a download link in regular browser tabs.

// HandOff says what happened to the file. 'needs-tap': Safari refused the
// Share Sheet because the tap that started the export was spent while the file
// was being prepared (share() needs a live user activation); the caller keeps
// the blob and offers a button whose own tap shares it right away.
export type HandOff = 'shared' | 'canceled' | 'downloaded' | 'needs-tap'

export async function shareOrDownload(blob: Blob, filename: string): Promise<HandOff> {
  const file = new File([blob], filename, { type: blob.type })
  if (typeof navigator.canShare === 'function' && navigator.canShare({ files: [file] })) {
    try {
      await navigator.share({ files: [file], title: filename })
      return 'shared'
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') return 'canceled' // dismissed
      if (err instanceof DOMException && err.name === 'NotAllowedError') return 'needs-tap'
      throw err
    }
  }
  download(blob, filename)
  return 'downloaded'
}

// download saves through a temporary link. The object URL is released later,
// not right after click(): Safari may still be reading it and would cancel the
// download.
export function download(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  setTimeout(() => URL.revokeObjectURL(url), 60_000)
}

export function backupFilename(): string {
  const d = new Date()
  const pad = (n: number) => String(n).padStart(2, '0')
  // .db, same extension the desktop app writes, so both sides' backups look
  // alike in Files/Drive and neither needs explaining.
  return `app-finance-${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}.db`
}
