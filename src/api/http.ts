import type { Response } from 'express';

import { StraboScopeError } from '../boundary/repository-root.ts';

/** Send a clear client error without running a scan. */
export function sendError(response: Response, error: unknown): void {
  if (error instanceof StraboScopeError) {
    response.status(400).json({ error: error.message });
    return;
  }
  response.status(500).json({ error: error instanceof Error ? error.message : 'Unknown error' });
}

/** Parse a positive integer query parameter, returning undefined when absent/invalid. */
export function parsePositiveInt(value: unknown): number | undefined {
  if (typeof value !== 'string' || value.trim() === '') {
    return undefined;
  }
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

export function parseBoolean(value: unknown): boolean {
  return value === '1' || value === 'true';
}
