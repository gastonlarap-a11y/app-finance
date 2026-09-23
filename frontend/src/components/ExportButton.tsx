import { useState } from 'react'
import type { ExportTable } from '@/services/contract'
import { saveTable } from '@/services/reports'
import { notify } from '@/lib/notify'
import { errorText } from '@/lib/useQuery'
import { IS_WEB } from '@/lib/platform'
import { Button } from './ui'

// ExportButton exports what the view shows: an .xlsx via the native Save dialog
// on desktop, a CSV through the Share Sheet on the web/iPad build.
export function ExportButton({ build, basename }: { build: () => ExportTable; basename: string }) {
  const [busy, setBusy] = useState(false)

  async function run() {
    setBusy(true)
    try {
      const outcome = await saveTable(build(), basename)
      if (outcome.status === 'saved' && !IS_WEB) notify(`Exportado a ${outcome.where}`, 'success')
    } catch (err) {
      notify(`No se pudo exportar: ${errorText(err)}`)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Button variant="ghost" onClick={run} disabled={busy}>
      {busy ? 'Exportando…' : IS_WEB ? '⬇ CSV' : '⬇ Excel'}
    </Button>
  )
}
