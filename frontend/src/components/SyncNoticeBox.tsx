import { syncNotice } from '@/lib/syncText'

const TONES = {
  ok: 'bg-success/10 text-green-200 ring-success/30',
  warn: 'bg-warning/10 text-amber-200 ring-warning/30',
  danger: 'bg-danger/10 text-red-200 ring-danger/30',
} as const

// SyncNoticeBox says, before a restore or import, whether the file keeps every
// change made on this device (nothing when the relation is unknown).
export function SyncNoticeBox({ sync }: { sync: string | null | undefined }) {
  const notice = syncNotice(sync)
  if (!notice) return null
  return (
    <p role={notice.tone === 'ok' ? 'status' : 'alert'} className={`mt-3 rounded-base px-3 py-2 text-sm ring-1 ${TONES[notice.tone]}`}>
      {notice.tone === 'ok' ? '✓ ' : '⚠ '}
      {notice.text}
    </p>
  )
}
