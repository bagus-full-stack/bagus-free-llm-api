import fs from 'fs';
import os from 'os';
import path from 'path';
import { describe, it, expect, afterEach } from 'vitest';
import { connectDb } from '../../db/index.js';

const created: string[] = [];

function tempDbPath(): string {
  const p = path.join(os.tmpdir(), `freeapi-hardening-${Date.now()}-${Math.random()}.db`);
  created.push(p);
  return p;
}

afterEach(() => {
  for (const p of created.splice(0)) {
    for (const suffix of ['', '-wal', '-shm']) {
      try { fs.unlinkSync(`${p}${suffix}`); } catch { /* best effort */ }
    }
  }
});

describe('database runtime hardening', () => {
  it('sets a busy timeout so concurrent writers wait instead of erroring', () => {
    const db = connectDb(tempDbPath());
    // pragma() returns a scalar or a row list depending on driver; normalise.
    const raw = db.pragma('busy_timeout');
    const value = Array.isArray(raw)
      ? Number((raw[0] as Record<string, unknown>).timeout ?? (raw[0] as Record<string, unknown>).busy_timeout)
      : Number(raw);
    expect(value).toBe(5000);
  });

  it('keeps foreign keys and WAL on', () => {
    const db = connectDb(tempDbPath());
    const fk = db.pragma('foreign_keys');
    const fkValue = Array.isArray(fk)
      ? Number((fk[0] as Record<string, unknown>).foreign_keys)
      : Number(fk);
    expect(fkValue).toBe(1);

    const jm = db.pragma('journal_mode');
    const jmValue = Array.isArray(jm)
      ? String((jm[0] as Record<string, unknown>).journal_mode)
      : String(jm);
    expect(jmValue.toLowerCase()).toBe('wal');
  });

  it('restricts the database file to the owner', () => {
    const dbPath = tempDbPath();
    connectDb(dbPath);

    // The DB holds encrypted provider keys and the dashboard password hash.
    const mode = fs.statSync(dbPath).mode & 0o777;
    expect(mode & 0o077).toBe(0);
  });

  it('restricts the WAL sidecars once they exist', () => {
    const dbPath = tempDbPath();
    const db = connectDb(dbPath);
    // Force a write so -wal/-shm are created, then reconnect to chmod them.
    db.exec('CREATE TABLE IF NOT EXISTS probe (id INTEGER PRIMARY KEY)');
    db.exec('INSERT INTO probe (id) VALUES (1)');
    connectDb(dbPath);

    for (const suffix of ['-wal', '-shm']) {
      const target = `${dbPath}${suffix}`;
      if (!fs.existsSync(target)) continue;
      const mode = fs.statSync(target).mode & 0o777;
      expect(mode & 0o077).toBe(0);
    }
  });

  it('works for an in-memory database without touching the filesystem', () => {
    expect(() => connectDb(':memory:')).not.toThrow();
  });
});
