import { listOrders } from '../../../orders/src/handlers/orders';

export function home(): Promise<Response> {
  return fetch('https://api.acme.test/orders');
}
