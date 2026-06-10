#!/usr/bin/env node
/**
 * generate-test-license.mjs
 *
 * Generate a test Premium license for local development.
 * DEV ONLY — does not work in production.
 *
 * Usage:
 *   node server/scripts/generate-test-license.mjs
 *   node server/scripts/generate-test-license.mjs --lifetime
 *   node server/scripts/generate-test-license.mjs --annual
 */

import crypto from 'crypto';
import path from 'path';
import { fileURLToPath } from 'url';
import Database from 'better-sqlite3';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = path.resolve(__dirname, '../../server/data/freeapi.db');

// Allowed to only work in development
const isDev = process.env.NODE_ENV !== 'production' && process.argv.includes('--dev-opt-in') === false;

if (isDev && process.env.NODE_ENV === 'production') {
  console.error('❌ ERROR: This script cannot run in production mode.');
  process.exit(1);
}

function main() {
  try {
    // Parse plan type from arguments
    const planArg = process.argv.find(arg => ['--annual', '--lifetime'].includes(arg)) || '--lifetime';
    const plan = planArg === '--annual' ? 'annual' : 'lifetime';

    // Generate a test key
    const testKey = `fla_dev_${crypto.randomBytes(24).toString('hex')}`;

    // Create a mock license status
    const mockLicense = {
      valid: true,
      plan,
      status: 'active',
      expiresAt: plan === 'annual' ? new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString() : null,
      cancelAtPeriodEnd: false,
      reason: null,
      checkedAtMs: Date.now(),
    };

    // Open database and store settings
    const db = new Database(DB_PATH);

    const SETTING_LICENSE_KEY = 'premium_license_key';
    const SETTING_LICENSE_STATUS = 'premium_license_status';

    db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)')
      .run(SETTING_LICENSE_KEY, testKey);

    db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)')
      .run(SETTING_LICENSE_STATUS, JSON.stringify(mockLicense));

    db.close();

    console.log('\n✅ Test Premium license generated successfully!\n');
    console.log(`📋 Details:`);
    console.log(`   License key: ${testKey.slice(0, 20)}...`);
    console.log(`   Plan: ${plan === 'lifetime' ? '🎁 Lifetime (never expires)' : '📅 Annual (1 year)'}`);
    console.log(`   Status: Active`);
    console.log(`\n🚀 Next steps:`);
    console.log(`   1. Start the server: npm run dev (in the server/ directory)`);
    console.log(`   2. Open the dashboard: http://localhost:5173`);
    console.log(`   3. Go to the Premium page to see your test license`);
    console.log(`   4. Click "Check for updates" to sync the live catalog`);
    console.log(`\n💡 The test key starts with "fla_dev_" to identify it as a dev key.\n`);
  } catch (err) {
    console.error('❌ Error:', err.message);
    process.exit(1);
  }
}

main();

