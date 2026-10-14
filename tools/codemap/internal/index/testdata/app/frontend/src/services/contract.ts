export interface ItemResult {
  error?: string
}

// ShopServiceContract is the surface both builds implement.
export interface ShopServiceContract {
  AddItem(name: string): Promise<ItemResult>
  RemoveCart(id: number): Promise<ItemResult>
}
