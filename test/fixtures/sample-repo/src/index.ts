import './polyfill.ts';
import { feature } from './feature.ts';
import { util } from './util.ts';

export function main(): string {
  return `${util()}:${feature()}`;
}
