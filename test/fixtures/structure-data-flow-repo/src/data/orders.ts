/** The data tier reads the recorded table, so a flow runs from the hub into `data`. */
export function readOrders(): string {
  return 'SELECT id FROM orders';
}
