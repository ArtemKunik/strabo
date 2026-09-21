import type { NarratorConfig } from '../types.ts';
import type { PersistedSettings } from '../state/settings-store.ts';

/**
 * Which environment variable locks each narrator field.
 *
 * A value set by an environment variable shows as locked in the UI
 * (`set by STRABO_NARRATOR_MODEL`) and cannot be overridden from the browser,
 * so a managed deployment stays managed.
 */
export const NARRATOR_ENV_VARS = {
  endpoint: 'STRABO_NARRATOR_ENDPOINT',
  model: 'STRABO_NARRATOR_MODEL',
  apiKeyEnv: 'STRABO_NARRATOR_KEY_ENV',
  budget: 'STRABO_NARRATOR_BUDGET',
  sendSource: 'STRABO_NARRATOR_SEND_SOURCE',
} as const;

export type NarratorField = keyof typeof NARRATOR_ENV_VARS;

/** For each field, the env var name when it locks the field, else null. */
export type NarratorLocks = Record<NarratorField, string | null>;

function positiveInt(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : null;
}

function cleanString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}

/** Which narrator fields the environment locks. Never throws. */
export function narratorLocks(env: NodeJS.ProcessEnv = process.env): NarratorLocks {
  return {
    endpoint: cleanString(env[NARRATOR_ENV_VARS.endpoint]) ? NARRATOR_ENV_VARS.endpoint : null,
    model: cleanString(env[NARRATOR_ENV_VARS.model]) ? NARRATOR_ENV_VARS.model : null,
    apiKeyEnv: cleanString(env[NARRATOR_ENV_VARS.apiKeyEnv]) ? NARRATOR_ENV_VARS.apiKeyEnv : null,
    budget: cleanString(env[NARRATOR_ENV_VARS.budget]) ? NARRATOR_ENV_VARS.budget : null,
    sendSource: env[NARRATOR_ENV_VARS.sendSource] !== undefined ? NARRATOR_ENV_VARS.sendSource : null,
  };
}

function envEnabled(value: string | undefined): boolean {
  return value === '1' || value?.toLowerCase() === 'online' || value?.toLowerCase() === 'true';
}

function envBudget(value: string | undefined): number | null {
  const parsed = Number.parseInt(value ?? '', 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

/**
 * The effective narrator config: the environment wins, persisted settings fill the rest.
 *
 * Returns `undefined` when neither side supplies an endpoint or a model, which keeps the
 * narrator inert. `apiKeyEnv` follows the same rule: an env binding wins, otherwise the
 * persisted binding applies (possibly null, meaning "stored key or none").
 */
export function effectiveNarratorConfig(
  env: NodeJS.ProcessEnv = process.env,
  persisted?: Pick<
    PersistedSettings,
    'narratorEndpoint' | 'narratorModel' | 'narratorKeyEnv' | 'narratorSendSource' | 'narratorBudget'
  > | null,
): NarratorConfig | undefined {
  const endpoint = cleanString(env[NARRATOR_ENV_VARS.endpoint]) ?? persisted?.narratorEndpoint?.trim() ?? null;
  const model = cleanString(env[NARRATOR_ENV_VARS.model]) ?? persisted?.narratorModel?.trim() ?? null;
  if (!endpoint && !model) {
    // Mirror configFromEnv: without either, there is no narrator section at all.
    // A caller that needs validation of a half-filled form should build the object directly.
    const fallback = {
      ...(persisted?.narratorKeyEnv?.trim() ? { apiKeyEnv: persisted.narratorKeyEnv.trim() } : {}),
      ...(positiveInt(persisted?.narratorBudget) ? { requestBudget: persisted!.narratorBudget as number } : {}),
      ...(persisted?.narratorSendSource === true ? { sendSource: true as const } : {}),
    };
    return Object.keys(fallback).length > 0 ? fallback : undefined;
  }
  const apiKeyEnv =
    cleanString(env[NARRATOR_ENV_VARS.apiKeyEnv]) ?? persisted?.narratorKeyEnv?.trim() ?? undefined;
  const requestBudget =
    envBudget(env[NARRATOR_ENV_VARS.budget]) ?? positiveInt(persisted?.narratorBudget) ?? undefined;
  const envSendSource = env[NARRATOR_ENV_VARS.sendSource];
  const sendSource =
    envSendSource !== undefined ? envEnabled(envSendSource) || undefined : persisted?.narratorSendSource === true || undefined;
  return {
    ...(endpoint ? { endpoint } : {}),
    ...(model ? { model } : {}),
    ...(apiKeyEnv ? { apiKeyEnv } : {}),
    ...(requestBudget ? { requestBudget } : {}),
    ...(sendSource ? { sendSource: true } : {}),
  };
}

/** The `host` (with port) of an endpoint string, or null when it is not a URL. */
export function endpointHostOf(endpoint: string | null | undefined): string | null {
  if (!endpoint) {
    return null;
  }
  try {
    return new URL(endpoint).host;
  } catch {
    return null;
  }
}
