/**
 * §UT1 — /var/log/wtmp.json and /var/log/btmp.json must accumulate as
 * SSH events fire. Today they are read by `last` / `lastb` but
 * nothing ever writes to them, so `lastb` always shows the synthetic
 * header alone — useless for an operator hunting brute-force traffic.
 *
 * The projection follows the same one-event-one-line discipline as
 * SshSyslogger: it subscribes to the SshServerEventBus and appends a
 * structured row (NOT the rendered text — `cmdLast/Lastb` already
 * format on read).
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { VirtualFileSystem } from '@/network/devices/linux/VirtualFileSystem';
import { SshServerEventBus } from '@/network/protocols/ssh/server/SshServerEvent';
import { LinuxUtmpProjection } from '@/network/protocols/ssh/logging/LinuxUtmpProjection';

describe('§UT1 — LinuxUtmpProjection writes /var/log/{wtmp,btmp}.json', () => {
  let vfs: VirtualFileSystem;
  let bus: SshServerEventBus;

  beforeEach(() => {
    vfs = new VirtualFileSystem();
    bus = new SshServerEventBus();
    new LinuxUtmpProjection(vfs, bus);
  });

  const readJson = (p: string): unknown[] => {
    const raw = vfs.readFile(p);
    return raw ? (JSON.parse(raw) as unknown[]) : [];
  };

  it('appends a wtmp row on auth_success', () => {
    bus.emit({ kind: 'auth_success', user: 'alice', method: 'password', ip: '10.0.0.5' });
    const rows = readJson('/var/log/wtmp.json') as Array<{ user: string; ip: string }>;
    expect(rows).toHaveLength(1);
    expect(rows[0].user).toBe('alice');
    expect(rows[0].ip).toBe('10.0.0.5');
  });

  it('appends a btmp row on auth_failure', () => {
    bus.emit({ kind: 'auth_failure', user: 'mallory', method: 'password', ip: '10.0.0.99', reason: 'bad password' });
    const rows = readJson('/var/log/btmp.json') as Array<{ user: string; reason: string }>;
    expect(rows).toHaveLength(1);
    expect(rows[0].user).toBe('mallory');
  });

  it('appends a btmp row on auth_invalid_user (unknown account)', () => {
    bus.emit({ kind: 'auth_invalid_user', user: 'ghost', ip: '10.0.0.99' });
    const rows = readJson('/var/log/btmp.json') as Array<{ user: string }>;
    expect(rows).toHaveLength(1);
    expect(rows[0].user).toBe('ghost');
  });

  it('does NOT mix success and failure streams', () => {
    bus.emit({ kind: 'auth_success', user: 'alice',   method: 'password', ip: '10.0.0.5' });
    bus.emit({ kind: 'auth_failure', user: 'mallory', method: 'password', ip: '10.0.0.99', reason: 'bad password' });
    expect(readJson('/var/log/wtmp.json')).toHaveLength(1);
    expect(readJson('/var/log/btmp.json')).toHaveLength(1);
  });
});
