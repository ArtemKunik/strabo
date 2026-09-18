import { util } from './util.ts';
import { libIndex } from '../lib/index.ts';

export function index(): string {
  return `${util()}:${libIndex()}`;
}
