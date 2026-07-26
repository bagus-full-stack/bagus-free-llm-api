import { getDb } from '../db/index.js';
import { resolveProvider } from '../providers/index.js';
import { decrypt } from '../lib/crypto.js';
import type { Platform, KeyStatus } from '@freellmapi/shared/types.js';
import { inferQuotaPoolKey } from './provider-quota.js';
import type { Scheduler } from '../lib/scheduler.js';
import { sanitizeProviderErrorMessage } from '../lib/error-redaction.js';

const CHECK_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
const CONSECUTIVE_FAILURES_TO_DISABLE = 3;
const DEFAULT_HEALTH_CHECK_CONCURRENCY = 8;

/** Parallel key probes per health pass. Tunable because the right number depends
 *  on how many keys share one provider; 0 or a bad value falls back to the default. */
function getHealthCheckConcurrency(): number {
  const raw = process.env.HEALTH_CHECK_CONCURRENCY;
  if (raw !== undefined && raw.trim() !== '') {
    const n = Number(raw);
    if (Number.isInteger(n) && n > 0) return n;
  }
  return DEFAULT_HEALTH_CHECK_CONCURRENCY;
}

// Track consecutive failures per key
const failureCount = new Map<number, number>();

function recordInvalidFailure(keyId: number): void {
  const count = (failureCount.get(keyId) ?? 0) + 1;
  failureCount.set(keyId, count);

  if (count >= CONSECUTIVE_FAILURES_TO_DISABLE) {
    getDb().prepare('UPDATE api_keys SET enabled = 0 WHERE id = ?').run(keyId);
    console.log(`[Health] Auto-disabled key ${keyId} after ${count} consecutive failures`);
  }
}

export async function checkKeyHealth(keyId: number): Promise<KeyStatus> {
  const db = getDb();
  const row = db.prepare('SELECT * FROM api_keys WHERE id = ?').get(keyId) as any;
  if (!row) return 'error';

  const provider = resolveProvider(row.platform as Platform, row.base_url);
  if (!provider) return 'error';

  try {
    const apiKey = decrypt(row.encrypted_key, row.iv, row.auth_tag);
    const validation = await provider.validateKey(apiKey, {
      platform: row.platform as Platform,
      keyId,
      quotaPoolKey: inferQuotaPoolKey(row.platform as Platform, null),
      endpoint: 'models',
      origin: 'health',
    });
    const isValid = typeof validation === 'boolean' ? validation : validation.valid;
    const lastError = isValid
      ? null
      : sanitizeProviderErrorMessage(
          typeof validation === 'boolean'
            ? `${provider.name} rejected the API key`
            : validation.error,
        );

    const status: KeyStatus = isValid ? 'healthy' : 'invalid';

    db.prepare("UPDATE api_keys SET status = ?, last_health_error = ?, last_checked_at = datetime('now') WHERE id = ?")
      .run(status, lastError, keyId);

    if (isValid) {
      failureCount.delete(keyId);
    } else {
      console.warn(
        `[Health] Key ${keyId} (${row.platform}, base=${row.base_url ?? 'default'}) invalid: ${lastError}`,
      );
      recordInvalidFailure(keyId);
    }

    return status;
  } catch (err: any) {
    // Transport errors (DNS/timeout/TLS) — provider unreachable, not necessarily
    // a bad key. Mark status='error' but do NOT increment failure counter — auto-
    // disable is reserved for confirmed 401/403 (returned by validateKey as false).
    // Include platform + base_url so a flapping CloudFront edge or DNS failure is
    // attributable to the responsible provider in one log read. The leading
    // "[Health] Key N (" prefix is preserved so the 12-hourly crash watchdog
    // (cron bff5ae167d28) that scrapes /tmp/freellmapi.log for these lines
    // continues to match unchanged.
    const lastError = sanitizeProviderErrorMessage(err?.message ?? err);
    console.error(
      `[Health] Key ${keyId} (${row.platform}, base=${row.base_url ?? 'default'}) ` +
      `transport error: ${lastError} — status preserved as '${row.status}'`,
    );
    // Do NOT write status='error'. selectKeyForModel only considers keys with
    // status IN ('healthy','unknown'), so demoting here silently removes the
    // key's capacity for up to a full check interval — and a transport error is
    // evidence about the network, not about the key. One flaky DNS lookup, a
    // laptop suspended for thirty seconds, or a provider edge outage would take
    // every key on that provider out of rotation at once. Record the diagnostic
    // and the timestamp; leave the verdict to a probe that actually reached the
    // provider. Confirmed 401/403 (the isValid=false path above) still demotes.
    db.prepare("UPDATE api_keys SET last_health_error = ?, last_checked_at = datetime('now') WHERE id = ?")
      .run(lastError, keyId);
    return row.status as KeyStatus;
  }
}

// ── Cooldown-probe validation (side-effect-free) ─────────────────────────────
// The cooldown-probe recovery job (services/cooldown-probe.ts) needs the same
// cheap validateKey call checkKeyHealth makes, WITHOUT any of its bookkeeping:
// no status writes, no last_checked_at, and above all no failureCount — probes
// run far more often than the 5-minute health pass, so letting them feed the
// consecutive-failure counter would auto-disable a genuinely-bad key in a
// fraction of the "3 consecutive checks" the threshold promises. A probe is a
// question, never a verdict.

export type KeyProbeOutcome = 'valid' | 'invalid' | 'error';

export async function probeKeyValidity(keyId: number): Promise<KeyProbeOutcome> {
  try {
    const db = getDb();
    const row = db.prepare('SELECT * FROM api_keys WHERE id = ? AND enabled = 1').get(keyId) as any;
    if (!row) return 'error';

    const provider = resolveProvider(row.platform as Platform, row.base_url);
    if (!provider) return 'error';

    const apiKey = decrypt(row.encrypted_key, row.iv, row.auth_tag);
    const validation = await provider.validateKey(apiKey, {
      platform: row.platform as Platform,
      keyId,
      quotaPoolKey: inferQuotaPoolKey(row.platform as Platform, null),
      endpoint: 'models',
      origin: 'probe',
    });
    const isValid = typeof validation === 'boolean' ? validation : validation.valid;
    return isValid ? 'valid' : 'invalid';
  } catch {
    // Transport error (DNS/timeout/TLS): inconclusive, same as checkKeyHealth's
    // reasoning — evidence about the network, not the key.
    return 'error';
  }
}

/**
 * Promote a key out of 'error' after it successfully served a live request.
 *
 * Serving traffic is stronger evidence than any probe, so a key stuck at 'error'
 * from an earlier transport blip should not have to wait for the next health pass
 * to become routable again. Deliberately narrow: 'invalid' means a provider
 * confirmed the credential is bad, and only a real validateKey pass clears that.
 */
export function markKeyHealthyFromRequest(keyId: number): void {
  try {
    getDb()
      .prepare("UPDATE api_keys SET status = 'healthy', last_health_error = NULL WHERE id = ? AND status = 'error'")
      .run(keyId);
    failureCount.delete(keyId);
  } catch {
    // Never let health bookkeeping break a request that already succeeded.
  }
}

// Overlap guard: the scheduled 5-minute pass and wake-recovery re-probes can
// coincide (or SIGCONT spam can queue several) — concurrent full passes
// multiply provider validate traffic and let two passes each increment the
// same genuinely-bad key's failureCount, reaching the auto-disable threshold
// in fewer wall-clock checks than "3 consecutive checks" intends. A second
// caller joins the in-flight pass instead of starting another.
let checkAllInFlight: Promise<void> | null = null;

export function checkAllKeys(): Promise<void> {
  if (checkAllInFlight) return checkAllInFlight;
  checkAllInFlight = (async () => {
    const db = getDb();
    const keys = db.prepare('SELECT id, platform FROM api_keys WHERE enabled = 1').all() as { id: number; platform: string }[];

    console.log(`[Health] Checking ${keys.length} keys...`);

    // Bounded worker pool rather than a sequential await. validateKey allows up
    // to 30s per key (some provider /models endpoints are genuinely that slow),
    // so a serial pass over a large key fleet can outlast the 5-minute interval
    // it is scheduled on and leave the dashboard showing stale statuses. The cap
    // keeps us from opening one socket per key against the same provider.
    const concurrency = getHealthCheckConcurrency();
    let cursor = 0;
    const workers = Array.from({ length: Math.min(concurrency, keys.length) }, async () => {
      while (cursor < keys.length) {
        const key = keys[cursor++]!;
        try {
          await checkKeyHealth(key.id);
        } catch (err) {
          // checkKeyHealth handles its own errors; this is a backstop so one
          // rejection cannot abandon the rest of the pass.
          console.error(`[Health] Key ${key.id} check threw:`, err);
        }
      }
    });
    await Promise.all(workers);

    console.log(`[Health] Check complete.`);
  })().finally(() => {
    checkAllInFlight = null;
  });
  return checkAllInFlight;
}

let cancelHealthCheck: (() => void) | null = null;

export function startHealthChecker(scheduler: Scheduler): void {
  if (cancelHealthCheck) return;
  console.log(`[Health] Starting health checker (every ${CHECK_INTERVAL_MS / 1000}s)`);
  cancelHealthCheck = scheduler.every(CHECK_INTERVAL_MS, () =>
    checkAllKeys().catch(err => console.error('[Health] Check failed:', err)),
  );
}

export function stopHealthChecker(): void {
  if (cancelHealthCheck) {
    cancelHealthCheck();
    cancelHealthCheck = null;
  }
}
