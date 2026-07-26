import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import { initDb, getDb } from '../../db/index.js';
import { applyDeclarativeConfig, applyDeclarativeConfigFromEnv } from '../../services/declarative-config.js';
import { getRoutingStrategy } from '../../services/router.js';

const ORIGINAL_CONFIG_JSON = process.env.FREEAPI_CONFIG_JSON;
const ORIGINAL_CONFIG_PATH = process.env.FREEAPI_CONFIG_PATH;

function restoreEnv() {
  if (ORIGINAL_CONFIG_JSON === undefined) delete process.env.FREEAPI_CONFIG_JSON;
  else process.env.FREEAPI_CONFIG_JSON = ORIGINAL_CONFIG_JSON;
  if (ORIGINAL_CONFIG_PATH === undefined) delete process.env.FREEAPI_CONFIG_PATH;
  else process.env.FREEAPI_CONFIG_PATH = ORIGINAL_CONFIG_PATH;
}

describe('declarative config import', () => {
  beforeAll(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
  });

  beforeEach(() => {
    delete process.env.FREEAPI_CONFIG_JSON;
    delete process.env.FREEAPI_CONFIG_PATH;
    getDb().prepare('DELETE FROM api_keys').run();
  });

  afterEach(() => restoreEnv());

  it('applies keys, custom providers, model overrides, fallback order and routing', () => {
    const target = getDb().prepare(`
      SELECT platform, model_id FROM models
       WHERE platform = 'groq' AND key_id IS NULL
       ORDER BY id LIMIT 1
    `).get() as { platform: string; model_id: string };

    const result = applyDeclarativeConfig({
      keys: [{ platform: 'groq', key: 'gsk_config_key', label: 'config' }],
      customProviders: [{
        baseUrl: 'http://127.0.0.1:9123/v1',
        apiKey: 'local-key',
        label: 'Local config',
        models: [{ model: 'local-chat', displayName: 'Local Chat', supportsTools: true, contextWindow: 32000 }],
      }],
      models: [{
        platform: target.platform,
        modelId: target.model_id,
        displayName: 'Config Display',
        supportsTools: true,
        contextWindow: 654321,
      }],
      fallback: [{ platform: target.platform, modelId: target.model_id, priority: 1, enabled: false }],
      routing: { strategy: 'custom', weights: { reliability: 3, speed: 1, intelligence: 2 } },
    });

    expect(result).toMatchObject({ applied: true, keys: 1, customModels: 1, models: 1, fallback: 1, routing: true });
    expect((getDb().prepare("SELECT COUNT(*) AS n FROM api_keys WHERE platform = 'groq'").get() as { n: number }).n).toBe(1);
    expect((getDb().prepare("SELECT COUNT(*) AS n FROM api_keys WHERE platform = 'custom'").get() as { n: number }).n).toBe(1);
    expect(getDb().prepare(`
      SELECT display_name, supports_tools, context_window FROM models
       WHERE platform = 'custom' AND model_id = 'local-chat'
    `).get()).toEqual({ display_name: 'Local Chat', supports_tools: 1, context_window: 32000 });

    const model = getDb().prepare(`
      SELECT m.display_name, m.supports_tools, m.context_window, fc.priority, fc.enabled AS fallback_enabled
        FROM models m
        JOIN fallback_config fc ON fc.model_db_id = m.id
       WHERE m.platform = ? AND m.model_id = ?
    `).get(target.platform, target.model_id) as {
      display_name: string;
      supports_tools: number;
      context_window: number;
      priority: number;
      fallback_enabled: number;
    };
    expect(model).toEqual({
      display_name: 'Config Display',
      supports_tools: 1,
      context_window: 654321,
      priority: 1,
      fallback_enabled: 0,
    });
    expect(getDb().prepare('SELECT overrides_json FROM model_overrides WHERE platform = ? AND model_id = ?')
      .get(target.platform, target.model_id)).toBeDefined();
    expect(getRoutingStrategy()).toBe('custom');

    applyDeclarativeConfig({
      models: [{ platform: target.platform, modelId: target.model_id, displayName: 'Edited Again' }],
    });
    expect((getDb().prepare(`
      SELECT fc.enabled AS fallback_enabled
        FROM models m
        JOIN fallback_config fc ON fc.model_db_id = m.id
       WHERE m.platform = ? AND m.model_id = ?
    `).get(target.platform, target.model_id) as { fallback_enabled: number }).fallback_enabled).toBe(0);
  });

  it('applies inline JSON from FREEAPI_CONFIG_JSON idempotently', () => {
    process.env.FREEAPI_CONFIG_JSON = JSON.stringify({
      keys: [{ platform: 'groq', key: 'gsk_config_key', label: 'config' }],
    });

    expect(applyDeclarativeConfigFromEnv().applied).toBe(true);
    expect(applyDeclarativeConfigFromEnv().applied).toBe(true);
    expect((getDb().prepare("SELECT COUNT(*) AS n FROM api_keys WHERE platform = 'groq' AND label = 'config'").get() as { n: number }).n).toBe(1);
  });

  // #600: pollinations lost `keyless: true` in #573, so a legacy declarative
  // config with a keyless-era pollinations entry (no `key`) used to throw at
  // boot and brick the install. Missing-key entries must now degrade to a
  // per-entry skip + warning instead of killing the apply.
  it('skips a legacy keyless entry without a key, warns, and still applies the rest', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const result = applyDeclarativeConfig({
        keys: [
          { platform: 'pollinations' },
          { platform: 'groq', key: 'gsk_config_key', label: 'config' },
        ],
      });
      expect(result.applied).toBe(true);
      expect(result.keys).toBe(1);
      expect(result.warnings).toHaveLength(1);
      expect(result.warnings[0]).toContain('pollinations');
      expect(result.warnings[0]).toContain('enter.pollinations.ai');
      expect(result.warnings[0]).toContain('entry skipped');
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('pollinations'));
      expect((getDb().prepare("SELECT COUNT(*) AS n FROM api_keys WHERE platform = 'pollinations'").get() as { n: number }).n).toBe(0);
      expect((getDb().prepare("SELECT COUNT(*) AS n FROM api_keys WHERE platform = 'groq'").get() as { n: number }).n).toBe(1);
    } finally {
      warn.mockRestore();
    }
  });

  it('boot apply (FromEnv) survives a legacy keyless pollinations entry', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      process.env.FREEAPI_CONFIG_JSON = JSON.stringify({
        keys: [
          { platform: 'pollinations', label: 'legacy' },
          { platform: 'groq', key: 'gsk_config_key', label: 'config' },
        ],
      });
      expect(() => applyDeclarativeConfigFromEnv()).not.toThrow();
      expect((getDb().prepare("SELECT COUNT(*) AS n FROM api_keys WHERE platform = 'groq'").get() as { n: number }).n).toBe(1);
      expect((getDb().prepare("SELECT COUNT(*) AS n FROM api_keys WHERE platform = 'pollinations'").get() as { n: number }).n).toBe(0);
    } finally {
      warn.mockRestore();
    }
  });

  it('still applies a pollinations entry that has a key', () => {
    const result = applyDeclarativeConfig({
      keys: [{ platform: 'pollinations', key: 'pk_live_abc', label: 'config' }],
    });
    expect(result.keys).toBe(1);
    expect(result.warnings).toHaveLength(0);
    expect((getDb().prepare("SELECT COUNT(*) AS n FROM api_keys WHERE platform = 'pollinations'").get() as { n: number }).n).toBe(1);
  });

  it('generic missing-key skip covers any non-keyless platform, with a platform-named warning', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const result = applyDeclarativeConfig({
        keys: [{ platform: 'groq' }],
      });
      expect(result.keys).toBe(0);
      expect(result.warnings).toHaveLength(1);
      expect(result.warnings[0]).toContain('groq');
      expect(result.warnings[0]).toContain('entry skipped');
    } finally {
      warn.mockRestore();
    }
  });

  it('a keyless platform entry without a key still applies its sentinel row', () => {
    const result = applyDeclarativeConfig({
      keys: [{ platform: 'kilo', label: 'config' }],
    });
    expect(result.keys).toBe(1);
    expect(result.warnings).toHaveLength(0);
    expect((getDb().prepare("SELECT COUNT(*) AS n FROM api_keys WHERE platform = 'kilo'").get() as { n: number }).n).toBe(1);
  });

  it('genuinely malformed config still fails loudly', () => {
    expect(() => applyDeclarativeConfig({ keys: [{ platform: 'groq' }], nonsense: true }))
      .toThrow(/invalid declarative config/);
    expect(() => applyDeclarativeConfig({ keys: [{ platform: 'unknown-platform', key: 'x' }] }))
      .toThrow(/unknown provider platform/);
    process.env.FREEAPI_CONFIG_JSON = '{ not json';
    expect(() => applyDeclarativeConfigFromEnv()).toThrow();
  });
});
