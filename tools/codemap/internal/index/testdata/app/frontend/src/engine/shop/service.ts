// Web engine: the same contract over local SQL.
import type { ShopServiceContract } from '@/services/contract'

export interface SqlDb {
  exec(sql: string, params?: unknown[]): void
}

export function createShopService(db: SqlDb): ShopServiceContract {
  // insertItem writes one row.
  function insertItem(name: string): void {
    db.exec('INSERT INTO items (name) VALUES (?)', [name])
  }

  const service: ShopServiceContract = {
    async AddItem(name: string) {
      insertItem(name)
      return {}
    },
    async RemoveCart(id: number) {
      const table = 'carts'
      db.exec(`UPDATE ${table} SET deleted = 1 WHERE id = ?`, [id])
      return {}
    },
  }
  return service
}
