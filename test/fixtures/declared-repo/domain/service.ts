import { start } from '../infra/server.ts';

export function service(): string {
  return `${start()}:${process.env.INFRA_URL ?? ''}`;
}
