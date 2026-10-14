import { ShopService } from '@/services/shop'

// CartForm adds an item to the cart.
export function CartForm() {
  async function submit(name: string) {
    await ShopService.AddItem(name)
  }
  return <button onClick={() => void submit('x')}>Add</button>
}

export function App() {
  return <CartForm />
}
