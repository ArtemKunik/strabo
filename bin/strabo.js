#!/usr/bin/env node
import { main } from '../dist/cli.js';

try {
  process.exitCode = await main();
} catch (error) {
  console.error('[strabo]', error instanceof Error ? error.message : error);
  process.exitCode = 1;
}
