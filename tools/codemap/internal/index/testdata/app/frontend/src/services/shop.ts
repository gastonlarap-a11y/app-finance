// Desktop wrapper: the Wails binding of the Go type shop.ShopService, typed as the contract.
import { ShopService as Bound } from '@/../bindings/example.com/app/backend/shop'
import type { ShopServiceContract } from '@/services/contract'

export const ShopService: ShopServiceContract = Bound
