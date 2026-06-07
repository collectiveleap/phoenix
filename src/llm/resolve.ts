/**
 * LLM Provider Resolution — auto-detect, preference, config.
 *
 * Priority order:
 * 1. PHOENIX_LLM_PROVIDER env var (explicit override)
 * 2. Saved preference in .phoenix/config.json
 * 3. Auto-detect from available API keys:
 *    - ANTHROPIC_API_KEY → anthropic
 *    - OPENAI_API_KEY → openai
 *    If both present, prefer anthropic.
 * 4. null (no provider available — fall back to stubs)
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { LLMProvider, LLMConfig } from './provider.js';
import { DEFAULT_MODELS } from './provider.js';
import { AnthropicProvider } from './anthropic.js';
import { OpenAIProvider } from './openai.js';
import { ClaudeCliProvider, isClaudeCliAvailable } from './claude-cli.js';

interface PhoenixConfig {
  llm?: LLMConfig;
}

/**
 * Resolve the LLM provider. Returns null if no provider is available.
 */
export function resolveProvider(phoenixDir?: string): LLMProvider | null {
  const config = phoenixDir ? loadConfig(phoenixDir) : {};

  // 1. Explicit env var override
  const envProvider = process.env.PHOENIX_LLM_PROVIDER;
  const envModel = process.env.PHOENIX_LLM_MODEL;

  // 2. Determine provider name
  let providerName = envProvider || config.llm?.provider || detectProvider();
  if (!providerName) return null;

  // 3. Determine model
  const model = envModel || config.llm?.model || DEFAULT_MODELS[providerName] || DEFAULT_MODELS.anthropic;

  // 4. Build provider
  const provider = buildProvider(providerName, model);
  if (!provider) return null;

  // 5. Save preference if we detected it (and have a phoenix dir)
  if (phoenixDir && !config.llm) {
    saveConfig(phoenixDir, {
      ...config,
      llm: { provider: providerName, model },
    });
  }

  return provider;
}

/**
 * Auto-detect which provider is available from env vars.
 */
function detectProvider(): string | null {
  if (process.env.ANTHROPIC_API_KEY) return 'anthropic';
  if (process.env.OPENAI_API_KEY) return 'openai';
  if (isClaudeCliAvailable()) return 'claude-cli';
  return null;
}

/** All providers with usable credentials right now. */
function availableProviders(): string[] {
  const available: string[] = [];
  if (process.env.ANTHROPIC_API_KEY) available.push('anthropic');
  if (process.env.OPENAI_API_KEY) available.push('openai');
  if (isClaudeCliAvailable()) available.push('claude-cli');
  return available;
}

type Source = 'env' | 'config' | 'auto-detect' | 'default' | 'none';

/** A fully-explained provider resolution (O6: state choice AND its source). */
export interface ProviderResolution {
  provider: LLMProvider | null;
  name: string | null;
  model: string | null;
  providerSource: Source;
  modelSource: Source;
  available: string[];
  /** Human-readable warnings about ambiguous or overridden selection. */
  conflicts: string[];
}

/**
 * Resolve the provider AND explain where each choice came from, surfacing any
 * conflicts (env vs config, or multiple credentials available). Has no side
 * effects — `resolveProvider` keeps the config-save behaviour.
 */
export function resolveProviderInfo(phoenixDir?: string): ProviderResolution {
  const config = phoenixDir ? loadConfig(phoenixDir) : {};
  const envProvider = process.env.PHOENIX_LLM_PROVIDER;
  const envModel = process.env.PHOENIX_LLM_MODEL;

  let name: string | null;
  let providerSource: Source;
  if (envProvider) { name = envProvider; providerSource = 'env'; }
  else if (config.llm?.provider) { name = config.llm.provider; providerSource = 'config'; }
  else { const d = detectProvider(); name = d; providerSource = d ? 'auto-detect' : 'none'; }

  let model: string | null;
  let modelSource: Source;
  if (!name) { model = null; modelSource = 'none'; }
  else if (envModel) { model = envModel; modelSource = 'env'; }
  else if (config.llm?.model) { model = config.llm.model; modelSource = 'config'; }
  else { model = DEFAULT_MODELS[name] || DEFAULT_MODELS.anthropic; modelSource = 'default'; }

  const available = availableProviders();
  const conflicts: string[] = [];
  if (envProvider && config.llm?.provider && envProvider !== config.llm.provider) {
    conflicts.push(`PHOENIX_LLM_PROVIDER=${envProvider} (env) overrides saved config provider '${config.llm.provider}'`);
  }
  if (envModel && config.llm?.model && envModel !== config.llm.model) {
    conflicts.push(`PHOENIX_LLM_MODEL=${envModel} (env) overrides saved config model '${config.llm.model}'`);
  }
  // Ambiguous selection: multiple credentials, no explicit override.
  if (!envProvider && !config.llm?.provider && available.length > 1) {
    conflicts.push(`Multiple providers available (${available.join(', ')}); defaulting to '${name}'. Set PHOENIX_LLM_PROVIDER to choose explicitly.`);
  }

  const provider = name ? buildProvider(name, model!) : null;
  return { provider, name, model, providerSource, modelSource, available, conflicts };
}

/** One-line + conflict-lines description for CLI output (O6). */
export function describeResolution(info: ProviderResolution): string[] {
  const lines: string[] = [];
  if (!info.name) {
    lines.push('No LLM provider resolved — falling back to stubs.');
    return lines;
  }
  lines.push(`Provider: ${info.name}/${info.model} (provider from ${info.providerSource}, model from ${info.modelSource})`);
  for (const c of info.conflicts) lines.push(`⚠ ${c}`);
  return lines;
}

/**
 * Build a provider instance.
 */
function buildProvider(name: string, model: string): LLMProvider | null {
  switch (name) {
    case 'anthropic': {
      const key = process.env.ANTHROPIC_API_KEY;
      if (!key) return null;
      return new AnthropicProvider(key, model);
    }
    case 'openai': {
      const key = process.env.OPENAI_API_KEY;
      if (!key) return null;
      return new OpenAIProvider(key, model);
    }
    case 'claude-cli': {
      return new ClaudeCliProvider(model || 'sonnet');
    }
    default:
      return null;
  }
}

/**
 * Load Phoenix config from .phoenix/config.json.
 */
function loadConfig(phoenixDir: string): PhoenixConfig {
  const configPath = join(phoenixDir, 'config.json');
  if (!existsSync(configPath)) return {};
  try {
    return JSON.parse(readFileSync(configPath, 'utf8'));
  } catch {
    return {};
  }
}

/**
 * Save Phoenix config to .phoenix/config.json.
 */
function saveConfig(phoenixDir: string, config: PhoenixConfig): void {
  mkdirSync(phoenixDir, { recursive: true });
  writeFileSync(
    join(phoenixDir, 'config.json'),
    JSON.stringify(config, null, 2) + '\n',
    'utf8',
  );
}

/**
 * Describe which providers are available (for CLI help).
 */
export function describeAvailability(): { available: string[]; configured: string | null; hint: string } {
  const available: string[] = [];
  if (process.env.ANTHROPIC_API_KEY) available.push('anthropic');
  if (process.env.OPENAI_API_KEY) available.push('openai');
  if (isClaudeCliAvailable()) available.push('claude-cli');

  const configured = process.env.PHOENIX_LLM_PROVIDER || null;

  let hint: string;
  if (available.length === 0) {
    hint = 'No LLM providers found. Set ANTHROPIC_API_KEY or OPENAI_API_KEY, or install Claude Code CLI to enable code generation. Falling back to stubs.';
  } else if (available.length === 1) {
    hint = `Using ${available[0]} (detected from env).`;
  } else {
    hint = `Multiple providers available: ${available.join(', ')}. Using ${configured || available[0]}. Set PHOENIX_LLM_PROVIDER to override.`;
  }

  return { available, configured, hint };
}
