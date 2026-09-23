import { atom, getDefaultStore } from 'jotai'

// In-app notices (toasts) replace window.alert: native dialogs block the webview,
// and Safari suppresses them in installed PWAs (see WebBackup.tsx).
export type NoticeTone = 'error' | 'success' | 'info'

export interface Notice {
  id: number
  message: string
  tone: NoticeTone
}

export const noticesAtom = atom<Notice[]>([])

const AUTO_DISMISS_MS = 6000
let nextId = 1

// notify can be called from any handler (not only components): it writes to the
// default jotai store the app renders with (no custom <Provider>).
export function notify(message: string, tone: NoticeTone = 'error'): void {
  const store = getDefaultStore()
  const id = nextId++
  store.set(noticesAtom, (list) => [...list, { id, message, tone }])
  setTimeout(() => dismiss(id), AUTO_DISMISS_MS)
}

export function dismiss(id: number): void {
  getDefaultStore().set(noticesAtom, (list) => list.filter((n) => n.id !== id))
}
