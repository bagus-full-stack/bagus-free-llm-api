import { Router } from 'express';
import type { Request, Response } from 'express';
import crypto from 'crypto';
import { getSetting, setSetting, getDb } from '../db/index.js';
import {
  SETTING_LICENSE_KEY,
  SETTING_LICENSE_STATUS,
  catalogBaseUrl,
  getCachedLicenseStatus,
  getSyncState,
  refreshLicenseStatus,
  syncCatalog,
} from '../services/catalog-sync.js';

export const premiumRouter = Router();

function maskKey(key: string): string {
  if (key.length <= 10) return key;
  return `${key.slice(0, 7)}…${key.slice(-4)}`;
}

function statusPayload() {
  const key = getSetting(SETTING_LICENSE_KEY);
  return {
    hasKey: Boolean(key),
    maskedKey: key ? maskKey(key) : null,
    license: getCachedLicenseStatus(),
    catalog: getSyncState(),
    // Where "Go Premium" / "recover key" links point. Overridable for forks.
    siteUrl: (process.env.PREMIUM_SITE_URL ?? 'https://freellmapi.co').replace(/\/$/, ''),
  };
}

/** GET /api/premium — everything the Premium page renders. */
premiumRouter.get('/', (_req: Request, res: Response) => {
  res.json(statusPayload());
});

/**
 * POST /api/premium/key { key } — activate a license key.
 * Validates against the catalog service first; only a key the service accepts
 * is stored. A live-tier sync is kicked off right away so the upgrade is
 * visible within seconds, not at the next 12h poll.
 */
premiumRouter.post('/key', async (req: Request, res: Response) => {
  const key = typeof req.body?.key === 'string' ? req.body.key.trim() : '';
  if (key.length < 8) {
    res.status(400).json({ error: 'Enter the license key from your purchase email.' });
    return;
  }

  let result: { valid: boolean; plan: string | null; status: string | null; expiresAt: string | null; reason?: string };
  try {
    const r = await fetch(`${catalogBaseUrl()}/v1/license/activate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key }),
      signal: AbortSignal.timeout(15000),
    });
    result = (await r.json()) as typeof result;
  } catch {
    res.status(502).json({ error: 'Could not reach the license service. Check your connection and try again.' });
    return;
  }

  if (!result.valid) {
    const reasons: Record<string, string> = {
      unknown_key: 'That key was not recognized. Check for typos, or use key recovery on the website.',
      expired: 'That key has expired. Renew on the website to keep the live catalog.',
      canceled: 'That subscription was canceled. Re-subscribe on the website to reactivate.',
      refunded: 'That purchase was refunded, so the key is no longer active.',
    };
    res.status(400).json({ error: reasons[result.reason ?? ''] ?? 'That key is not active.' });
    return;
  }

  setSetting(SETTING_LICENSE_KEY, key);
  await refreshLicenseStatus();
  const sync = await syncCatalog(true);
  res.json({ ...statusPayload(), sync });
});

/** DELETE /api/premium/key — deactivate locally (the purchase itself is untouched). */
premiumRouter.delete('/key', async (_req: Request, res: Response) => {
  const db = getDb();
  db.prepare('DELETE FROM settings WHERE key IN (?, ?)').run(SETTING_LICENSE_KEY, SETTING_LICENSE_STATUS);
  // Drop back to the free tier in the background; failure just means the next
  // scheduled poll handles it.
  void syncCatalog(true);
  res.json(statusPayload());
});

/** POST /api/premium/sync — manual "check for updates now". */
premiumRouter.post('/sync', async (_req: Request, res: Response) => {
  await refreshLicenseStatus();
  const sync = await syncCatalog(true);
  res.json({ ...statusPayload(), sync });
});

/**
 * POST /api/premium/portal — Stripe Billing Portal session for the stored key.
 * This is how an annual subscriber cancels, updates a card, or pulls invoices,
 * entirely self-serve.
 */
premiumRouter.post('/portal', async (_req: Request, res: Response) => {
  const key = getSetting(SETTING_LICENSE_KEY);
  if (!key) {
    res.status(400).json({ error: 'No license key configured.' });
    return;
  }
  try {
    const r = await fetch(`${catalogBaseUrl()}/v1/portal`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key }),
      signal: AbortSignal.timeout(15000),
    });
    const body = (await r.json()) as { url?: string; error?: string };
    if (!r.ok || !body.url) {
      res.status(502).json({ error: body.error ?? 'Could not open the billing portal.' });
      return;
    }
    res.json({ url: body.url });
  } catch {
    res.status(502).json({ error: 'Could not reach the billing service. Try again shortly.' });
  }
});

/** POST /api/premium/admin/generate-test-key — DEV ONLY. Generate a test Premium license. */
premiumRouter.post('/admin/generate-test-key', async (_req: Request, res: Response) => {
  // IMPORTANT: This endpoint only works in development mode.
  if (process.env.NODE_ENV === 'production') {
    res.status(403).json({ error: 'This endpoint is not available in production.' });
    return;
  }

  try {
    // Generate a test key in format: fla_dev_<random>
    const testKey = `fla_dev_${crypto.randomBytes(24).toString('hex')}`;

    // Create a mock license status (lifetime for convenience)
    const mockLicense = {
      valid: true,
      plan: 'lifetime' as const,
      status: 'active',
      expiresAt: null,
      cancelAtPeriodEnd: false,
      reason: null,
      checkedAtMs: Date.now(),
    };

    // Store in settings
    setSetting(SETTING_LICENSE_KEY, testKey);
    setSetting(SETTING_LICENSE_STATUS, JSON.stringify(mockLicense));

    // Trigger a catalog sync with the new test key
    await syncCatalog(true);

    // Return the new status
    res.json({
      ...statusPayload(),
      message: '✅ Test Premium license generated. Use "Check for updates" to sync the live catalog.',
      testKey,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: `Failed to generate test license: ${message}` });
  }
});
