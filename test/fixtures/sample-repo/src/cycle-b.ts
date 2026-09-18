import { a } from './cycle-a.ts';

export function b(): string {
  return a();
}
