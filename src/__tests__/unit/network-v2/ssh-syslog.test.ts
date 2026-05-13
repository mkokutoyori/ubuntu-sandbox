/**
 * SshSyslogger — reactive auth.log producer.
 *
 * Tests that auth/session/disconnect events on the SshServerEventBus
 * are translated into OpenSSH-compatible /var/log/auth.log lines.
 *
 * Format (from a real Ubuntu sshd):
 *   May 11 13:45:23 sandbox-host sshd[12345]: <message>
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { VirtualFileSystem } from '@/network/devices/linux/VirtualFileSystem';
import { SshServerEventBus } from '@/network/protocols/ssh/server/SshServerEvent';
import { SshSyslogger } from '@/network/protocols/ssh/logging/SshSyslogger';

describe('SshSyslogger — reactive auth.log producer', () => {
  let vfs: VirtualFileSystem;
  let bus: SshServerEventBus;
  let logger: SshSyslogger;
  const FIXED_NOW = new Date(Date.UTC(2026, 4, 11, 13, 45, 23));

  beforeEach(() => {
    vfs = new VirtualFileSystem();
    bus = new SshServerEventBus();
    logger = new SshSyslogger(vfs, bus, {
      hostname: 'sandbox-host',
      sshdPid: 12345,
      clock: () => FIXED_NOW,
    });
  });

  const readAuthLog = () => vfs.readFile('/var/log/auth.log') ?? '';

  it('creates /var/log/auth.log on first event', () => {
    bus.emit({ kind: 'client_connected', ip: '10.0.0.2', timestamp: Date.now() });
    expect(vfs.exists('/var/log/auth.log')).toBe(true);
  });

  it('uses OpenSSH timestamp + hostname + sshd[pid] header', () => {
    bus.emit({ kind: 'auth_success', user: 'alice', method: 'password', ip: '10.0.0.2' });
    expect(readAuthLog()).toMatch(/^May 11 13:45:23 sandbox-host sshd\[12345\]: /);
  });

  it('logs Accepted password line for password auth_success', () => {
    bus.emit({ kind: 'auth_success', user: 'alice', method: 'password', ip: '10.0.0.2' });
    expect(readAuthLog()).toContain(
      'Accepted password for alice from 10.0.0.2 port 22 ssh2',
    );
  });

  it('logs Accepted publickey with fingerprint for publickey auth_success', () => {
    bus.emit({
      kind: 'auth_success',
      user: 'alice',
      method: 'publickey',
      ip: '10.0.0.2',
      keyFingerprint: 'SHA256:abc123',
    });
    expect(readAuthLog()).toContain(
      'Accepted publickey for alice from 10.0.0.2 port 22 ssh2: ED25519 SHA256:abc123',
    );
  });

  it('logs Failed password for password auth_failure', () => {
    bus.emit({
      kind: 'auth_failure',
      user: 'alice',
      method: 'password',
      reason: 'wrong_password',
      ip: '10.0.0.2',
    });
    expect(readAuthLog()).toContain(
      'Failed password for alice from 10.0.0.2 port 22 ssh2',
    );
  });

  it('logs Invalid user line for auth_invalid_user', () => {
    bus.emit({ kind: 'auth_invalid_user', user: 'ghost', ip: '10.0.0.2' });
    expect(readAuthLog()).toContain('Invalid user ghost from 10.0.0.2 port 22');
  });

  it('logs Connection closed for client_disconnected', () => {
    bus.emit({
      kind: 'client_disconnected',
      user: 'alice',
      ip: '10.0.0.2',
      reason: 'client_disconnect',
    });
    expect(readAuthLog()).toContain(
      'Connection closed by authenticating user alice 10.0.0.2',
    );
  });

  it('logs session opened for channel_opened', () => {
    bus.emit({ kind: 'channel_opened', user: 'alice', channelType: 'shell' });
    expect(readAuthLog()).toContain(
      'pam_unix(sshd:session): session opened for user alice',
    );
  });

  it('logs session closed for channel_closed', () => {
    bus.emit({
      kind: 'channel_closed',
      user: 'alice',
      channelType: 'shell',
      durationMs: 5000,
    });
    expect(readAuthLog()).toContain(
      'pam_unix(sshd:session): session closed for user alice',
    );
  });

  it('logs throttling decisions for auth_throttled', () => {
    bus.emit({
      kind: 'auth_throttled',
      ip: '10.0.0.2',
      failuresInWindow: 5,
      windowSeconds: 60,
      blockUntil: Date.now() + 300_000,
    });
    expect(readAuthLog()).toContain(
      'Refusing connection from 10.0.0.2: 5 authentication failures',
    );
  });

  it('appends to auth.log across multiple events (order preserved)', () => {
    bus.emit({ kind: 'auth_success', user: 'alice', method: 'password', ip: '10.0.0.2' });
    bus.emit({ kind: 'auth_success', user: 'bob', method: 'password', ip: '10.0.0.3' });
    const lines = readAuthLog().split('\n').filter(Boolean);
    expect(lines.length).toBe(2);
    expect(lines[0]).toContain('alice');
    expect(lines[1]).toContain('bob');
  });

  it('stops writing after dispose()', () => {
    logger.dispose();
    bus.emit({ kind: 'auth_success', user: 'alice', method: 'password', ip: '10.0.0.2' });
    expect(vfs.exists('/var/log/auth.log')).toBe(false);
  });

  it('uses space-padding for single-digit days (real syslog format)', () => {
    const earlyMay = new Date(Date.UTC(2026, 4, 3, 9, 0, 0));
    const v = new VirtualFileSystem();
    const b = new SshServerEventBus();
    new SshSyslogger(v, b, { hostname: 'h', sshdPid: 1, clock: () => earlyMay });
    b.emit({ kind: 'auth_success', user: 'a', method: 'password', ip: '1.1.1.1' });
    expect(v.readFile('/var/log/auth.log')).toMatch(/^May  3 09:00:00 /);
  });
});
