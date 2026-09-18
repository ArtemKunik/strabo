import { index } from './src/index.ts';
import { libIndex } from './lib/index.ts';

export function main(): string {
  return `${index()}:${libIndex()}`;
}
