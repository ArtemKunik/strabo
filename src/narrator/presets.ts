/**
 * Provider presets for the in-app narrator setup.
 *
 * Every preset is OpenAI-compatible on the wire: the client sends an OpenAI-style
 * `messages` body to `<endpoint>`. The Anthropic preset uses Anthropic's
 * OpenAI-compatible endpoint (`https://api.anthropic.com/v1/chat/completions`,
 * via base URL `https://api.anthropic.com/v1/`), which the current Anthropic docs
 * confirm fits `chat.completions` calls — so no native Messages API adapter is
 * needed. The same holds for Ollama, LM Studio, OpenAI, and OpenRouter.
 *
 * A preset only fills the endpoint and suggests models; every field stays editable.
 */

export interface NarratorPreset {
  /** Stable id used by the Settings panel. */
  id: string;
  /** Display label, e.g. "Local · Ollama". */
  label: string;
  /** Chat-completions endpoint to fill in, or empty for Custom. */
  endpoint: string;
  /** Suggested model ids; picked rather than typed, but always editable. */
  models: string[];
  /** True when the provider normally needs an API key. Local presets do not. */
  needsKey: boolean;
}

export const NARRATOR_PRESETS: NarratorPreset[] = [
  {
    id: 'ollama',
    label: 'Local · Ollama',
    endpoint: 'http://127.0.0.1:11434/v1/chat/completions',
    models: ['llama3.1', 'qwen3', 'mistral'],
    needsKey: false,
  },
  {
    id: 'lmstudio',
    label: 'Local · LM Studio',
    endpoint: 'http://127.0.0.1:1234/v1/chat/completions',
    models: [],
    needsKey: false,
  },
  {
    id: 'openai',
    label: 'OpenAI',
    endpoint: 'https://api.openai.com/v1/chat/completions',
    models: ['gpt-4o-mini', 'gpt-4o'],
    needsKey: true,
  },
  {
    id: 'anthropic',
    label: 'Anthropic',
    endpoint: 'https://api.anthropic.com/v1/chat/completions',
    models: ['claude-sonnet-4-6', 'claude-opus-4-7', 'claude-haiku-4-5'],
    needsKey: true,
  },
  {
    id: 'openrouter',
    label: 'OpenRouter',
    endpoint: 'https://openrouter.ai/api/v1/chat/completions',
    models: ['anthropic/claude-sonnet-4', 'openai/gpt-4o-mini'],
    needsKey: true,
  },
  {
    id: 'custom',
    label: 'Custom',
    endpoint: '',
    models: [],
    needsKey: true,
  },
];

export function narratorPresetById(id: string | undefined): NarratorPreset | undefined {
  return NARRATOR_PRESETS.find((preset) => preset.id === id);
}
