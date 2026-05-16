/**
 * Extended sshd_config — directives added beyond the original BRD set:
 *   - PermitEmptyPasswords
 *   - LoginGraceTime
 *   - ClientAliveInterval / ClientAliveCountMax
 *   - MaxSessions
 *   - LogLevel / SyslogFacility
 *   - DenyUsers / AllowGroups / DenyGroups
 *   - KbdInteractiveAuthentication
 *   - X11Forwarding / AllowTcpForwarding
 *
 * All values are parsed case-insensitively and survive a round-trip
 * through serialize → parse.
 */

import { describe, it, expect } from 'vitest';
import {
  DEFAULT_SSHD_CONFIG,
  parseSshdConfig,
  serializeSshdConfig,
} from '@/network/protocols/ssh/server/SshSshdConfig';

describe('parseSshdConfig — extended directives', () => {
  it('keeps secure defaults when nothing is specified', () => {
    const cfg = parseSshdConfig('');
    expect(cfg.permitEmptyPasswords).toBe(false);
    expect(cfg.loginGraceTime).toBe(120);
    expect(cfg.clientAliveInterval).toBe(0);
    expect(cfg.clientAliveCountMax).toBe(3);
    expect(cfg.maxSessions).toBe(10);
    expect(cfg.logLevel).toBe('INFO');
    expect(cfg.syslogFacility).toBe('AUTH');
    expect(cfg.kbdInteractiveAuthentication).toBe(false);
    expect(cfg.x11Forwarding).toBe(false);
    expect(cfg.allowTcpForwarding).toBe('yes');
    expect(cfg.denyUsers).toEqual([]);
    expect(cfg.allowGroups).toEqual([]);
    expect(cfg.denyGroups).toEqual([]);
  });

  it('parses PermitEmptyPasswords', () => {
    expect(parseSshdConfig('PermitEmptyPasswords yes\n').permitEmptyPasswords).toBe(true);
    expect(parseSshdConfig('PermitEmptyPasswords no\n').permitEmptyPasswords).toBe(false);
  });

  it('parses numeric directives', () => {
    const cfg = parseSshdConfig(
      [
        'LoginGraceTime 30',
        'ClientAliveInterval 120',
        'ClientAliveCountMax 5',
        'MaxSessions 25',
      ].join('\n'),
    );
    expect(cfg.loginGraceTime).toBe(30);
    expect(cfg.clientAliveInterval).toBe(120);
    expect(cfg.clientAliveCountMax).toBe(5);
    expect(cfg.maxSessions).toBe(25);
  });

  it('parses LogLevel and SyslogFacility', () => {
    const cfg = parseSshdConfig('LogLevel VERBOSE\nSyslogFacility AUTHPRIV\n');
    expect(cfg.logLevel).toBe('VERBOSE');
    expect(cfg.syslogFacility).toBe('AUTHPRIV');
  });

  it('parses DenyUsers / AllowGroups / DenyGroups (space-separated lists)', () => {
    const cfg = parseSshdConfig(
      'DenyUsers root mallory\nAllowGroups sshusers admins\nDenyGroups nope\n',
    );
    expect(cfg.denyUsers).toEqual(['root', 'mallory']);
    expect(cfg.allowGroups).toEqual(['sshusers', 'admins']);
    expect(cfg.denyGroups).toEqual(['nope']);
  });

  it('parses X11Forwarding and KbdInteractiveAuthentication', () => {
    const cfg = parseSshdConfig(
      'X11Forwarding yes\nKbdInteractiveAuthentication yes\n',
    );
    expect(cfg.x11Forwarding).toBe(true);
    expect(cfg.kbdInteractiveAuthentication).toBe(true);
  });

  it('parses AllowTcpForwarding with the four real values', () => {
    expect(parseSshdConfig('AllowTcpForwarding no\n').allowTcpForwarding).toBe('no');
    expect(parseSshdConfig('AllowTcpForwarding local\n').allowTcpForwarding).toBe('local');
    expect(parseSshdConfig('AllowTcpForwarding remote\n').allowTcpForwarding).toBe('remote');
    expect(parseSshdConfig('AllowTcpForwarding all\n').allowTcpForwarding).toBe('all');
  });

  it('is case-insensitive on directive names', () => {
    const cfg = parseSshdConfig('PERMITemptypasswords YES\nloginGRACEtime 5\n');
    expect(cfg.permitEmptyPasswords).toBe(true);
    expect(cfg.loginGraceTime).toBe(5);
  });

  it('survives a serialize → parse round-trip', () => {
    const original = {
      ...DEFAULT_SSHD_CONFIG,
      permitEmptyPasswords: true,
      loginGraceTime: 45,
      clientAliveInterval: 60,
      clientAliveCountMax: 2,
      maxSessions: 4,
      logLevel: 'VERBOSE' as const,
      syslogFacility: 'AUTHPRIV',
      kbdInteractiveAuthentication: true,
      x11Forwarding: true,
      allowTcpForwarding: 'local' as const,
      denyUsers: ['root'],
      allowGroups: ['sshusers'],
      denyGroups: ['locked'],
    };
    const reparsed = parseSshdConfig(serializeSshdConfig(original));
    expect(reparsed.permitEmptyPasswords).toBe(true);
    expect(reparsed.loginGraceTime).toBe(45);
    expect(reparsed.clientAliveInterval).toBe(60);
    expect(reparsed.maxSessions).toBe(4);
    expect(reparsed.logLevel).toBe('VERBOSE');
    expect(reparsed.syslogFacility).toBe('AUTHPRIV');
    expect(reparsed.kbdInteractiveAuthentication).toBe(true);
    expect(reparsed.x11Forwarding).toBe(true);
    expect(reparsed.allowTcpForwarding).toBe('local');
    expect(reparsed.denyUsers).toEqual(['root']);
    expect(reparsed.allowGroups).toEqual(['sshusers']);
    expect(reparsed.denyGroups).toEqual(['locked']);
  });
});
