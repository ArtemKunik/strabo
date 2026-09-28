import { orderDomain } from '../domain/orders';

export function audit(): string {
  return orderDomain('audit');
}
