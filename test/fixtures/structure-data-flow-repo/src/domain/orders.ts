/** The domain tier writes the recorded table, so a flow runs from `domain` into the hub. */
export function recordOrder(): string {
  return 'INSERT INTO orders (id, total) VALUES (1, 10)';
}
