// syncNotice explains, before a restore or an import replaces the data, how the
// incoming file relates to what this device has (the version-vector check of
// backend/shared/db/syncstate.go and engine/db/syncstate.ts).
export type SyncNotice = { tone: 'ok' | 'warn' | 'danger'; text: string }

export function syncNotice(sync: string | null | undefined): SyncNotice | null {
  switch (sync) {
    case 'igual':
      return { tone: 'ok', text: 'Tiene los mismos datos que este dispositivo.' }
    case 'mas-nueva':
      return { tone: 'ok', text: 'Tiene todo lo de este dispositivo y cambios nuevos: no se pierde nada.' }
    case 'mas-antigua':
      return {
        tone: 'warn',
        text: 'Es más antiguo que lo que tienes aquí: se perderán los cambios hechos en este dispositivo desde entonces.',
      }
    case 'divergente':
      return {
        tone: 'danger',
        text:
          'Los dos dispositivos tienen cambios que el otro no tiene. Si continúas se perderán los de este dispositivo: ' +
          'exporta primero lo de aquí, o anota lo que falte para registrarlo después.',
      }
    default:
      return null
  }
}
