import { orderDomain } from '../domain/orders';
import { orderStore } from '../data/orders';

export function listOrders(): string {
  return orderDomain(orderStore());
}
