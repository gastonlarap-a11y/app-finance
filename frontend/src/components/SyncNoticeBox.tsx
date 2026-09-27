import { syncNotice } from '@/lib/syncText'
import { Callout } from './ui'

const TONE = { ok: 'positive', warn: 'caution', danger: 'negative' } as const

// SyncNoticeBox says, before a restore or import, whether the file keeps every
// change made on this device (nothing when the relation is unknown).
export function SyncNoticeBox({ sync }: { sync: string | null | undefined }) {
  const notice = syncNotice(sync)
  if (!notice) return null
  return (
    <Callout tone={TONE[notice.tone]} role={notice.tone === 'ok' ? 'status' : 'alert'} className="mt-3">
      {notice.text}
    </Callout>
  )
}
