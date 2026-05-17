/**
 * LinuxRmanContext live integration (§9.2).
 *
 * Verifies that when a device has a registered OracleDatabase,
 * LinuxRmanContext.forDevice() consults it for:
 *   - getInstanceState()  → tracks SHUTDOWN / NOMOUNT / MOUNT / OPEN live
 *   - dbName              → reflects the instance SID
 *   - getDatafiles()      → paths derived from the live SID
 *
 * Falls back to a static OPEN/ORCL context when no Oracle is registered.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { LinuxRmanContext } from '@/terminal/subshells/rman';
import { OracleDatabase } from '@/database/oracle/OracleDatabase';
import {
  getOracleDatabase, removeOracleDatabase, getRegisteredOracleDatabase,
} from '@/terminal/commands/database';

/** Minimal Equipment-shaped stub: just an id is needed for the lookup. */
function deviceWith(id: string): { id: string } {
  return { id };
}

describe('LinuxRmanContext.forDevice — fallback path', () => {
  it('returns the static ORCL context when no Oracle is registered', () => {
    const ctx = LinuxRmanContext.forDevice(deviceWith('no-oracle') as never);
    expect(ctx.dbName).toBe('ORCL');
    expect(ctx.getInstanceState?.()).toBe('OPEN');
    const dfs = ctx.getDatafiles();
    expect(dfs.length).toBeGreaterThan(0);
    expect(dfs.every(df => df.path.includes('ORCL'))).toBe(true);
  });
});

describe('LinuxRmanContext.forDevice — live OracleDatabase wiring', () => {
  const deviceId = 'live-ora-A';

  beforeEach(() => removeOracleDatabase(deviceId));
  afterEach(() => removeOracleDatabase(deviceId));

  it('reflects the live SID in dbName and datafile paths', () => {
    // getOracleDatabase boots the instance to OPEN automatically.
    const db = getOracleDatabase(deviceId);
    const sid = db.instance.config.sid;
    const ctx = LinuxRmanContext.forDevice(deviceWith(deviceId) as never);

    expect(ctx.dbName).toBe(sid);
    const dfs = ctx.getDatafiles();
    expect(dfs.every(df => df.path.includes(sid))).toBe(true);
  });

  it('getInstanceState() tracks the live OracleInstance state machine', () => {
    const db = getOracleDatabase(deviceId);
    const ctx = LinuxRmanContext.forDevice(deviceWith(deviceId) as never);

    expect(ctx.getInstanceState?.()).toBe('OPEN');

    db.instance.shutdown('IMMEDIATE');
    expect(ctx.getInstanceState?.()).toBe('SHUTDOWN');

    db.instance.startup('MOUNT');
    expect(ctx.getInstanceState?.()).toBe('MOUNT');

    // OPEN requires a full restart (the simulator has no ALTER DATABASE OPEN).
    db.instance.shutdown('IMMEDIATE');
    db.instance.startup();
    expect(ctx.getInstanceState?.()).toBe('OPEN');
  });

  it('the same device id always wraps the same live database', () => {
    getOracleDatabase(deviceId);
    const a = LinuxRmanContext.forDevice(deviceWith(deviceId) as never);
    const b = LinuxRmanContext.forDevice(deviceWith(deviceId) as never);
    expect(a.dbName).toBe(b.dbName);
    // Mutate via one; the other sees the change because both pull from
    // the same registered instance.
    const db = getRegisteredOracleDatabase(deviceId)!;
    db.instance.shutdown('IMMEDIATE');
    expect(a.getInstanceState?.()).toBe('SHUTDOWN');
    expect(b.getInstanceState?.()).toBe('SHUTDOWN');
  });
});
