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
import { SshdServerConfig } from '@/network/protocols/ssh/server/SshdServerConfig';

describe('SshdServerConfig.parse — extended directives', () => {
  it('keeps secure defaults when nothing is specified', () => {
    const cfg = SshdServerConfig.parse('');
    expect(cfg.permitEmptyPasswords).toBe(false);
    expect(cfg.loginGraceTimeSeconds).toBe(120);
    expect(cfg.clientAliveIntervalSeconds).toBe(0);
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
    expect(SshdServerConfig.parse('PermitEmptyPasswords yes\n').permitEmptyPasswords).toBe(true);
    expect(SshdServerConfig.parse('PermitEmptyPasswords no\n').permitEmptyPasswords).toBe(false);
  });

  it('parses numeric directives', () => {
    const cfg = SshdServerConfig.parse(
      [
        'LoginGraceTime 30',
        'ClientAliveInterval 120',
        'ClientAliveCountMax 5',
        'MaxSessions 25',
      ].join('\n'),
    );
    expect(cfg.loginGraceTimeSeconds).toBe(30);
    expect(cfg.clientAliveIntervalSeconds).toBe(120);
    expect(cfg.clientAliveCountMax).toBe(5);
    expect(cfg.maxSessions).toBe(25);
  });

  it('parses LogLevel and SyslogFacility', () => {
    const cfg = SshdServerConfig.parse('LogLevel VERBOSE\nSyslogFacility AUTHPRIV\n');
    expect(cfg.logLevel).toBe('VERBOSE');
    expect(cfg.syslogFacility).toBe('AUTHPRIV');
  });

  it('parses DenyUsers / AllowGroups / DenyGroups (space-separated lists)', () => {
    const cfg = SshdServerConfig.parse(
      'DenyUsers root mallory\nAllowGroups sshusers admins\nDenyGroups nope\n',
    );
    expect(cfg.denyUsers).toEqual(['root', 'mallory']);
    expect(cfg.allowGroups).toEqual(['sshusers', 'admins']);
    expect(cfg.denyGroups).toEqual(['nope']);
  });

  it('parses X11Forwarding and KbdInteractiveAuthentication', () => {
    const cfg = SshdServerConfig.parse(
      'X11Forwarding yes\nKbdInteractiveAuthentication yes\n',
    );
    expect(cfg.x11Forwarding).toBe(true);
    expect(cfg.kbdInteractiveAuthentication).toBe(true);
  });

  it('parses AllowTcpForwarding with the four real values', () => {
    expect(SshdServerConfig.parse('AllowTcpForwarding no\n').allowTcpForwarding).toBe('no');
    expect(SshdServerConfig.parse('AllowTcpForwarding local\n').allowTcpForwarding).toBe('local');
    expect(SshdServerConfig.parse('AllowTcpForwarding remote\n').allowTcpForwarding).toBe('remote');
    expect(SshdServerConfig.parse('AllowTcpForwarding all\n').allowTcpForwarding).toBe('all');
  });

  it('is case-insensitive on directive names', () => {
    const cfg = SshdServerConfig.parse('PERMITemptypasswords YES\nloginGRACEtime 5\n');
    expect(cfg.permitEmptyPasswords).toBe(true);
    expect(cfg.loginGraceTimeSeconds).toBe(5);
  });

  it('survives a serialize → parse round-trip', () => {
    const original = SshdServerConfig.parse([
      'PermitEmptyPasswords yes', 'LoginGraceTime 45', 'ClientAliveInterval 60', 'ClientAliveCountMax 2',
      'MaxSessions 4', 'LogLevel VERBOSE', 'SyslogFacility AUTHPRIV', 'KbdInteractiveAuthentication yes',
      'X11Forwarding yes', 'AllowTcpForwarding local', 'DenyUsers root', 'AllowGroups sshusers', 'DenyGroups locked',
    ].join('\n'));
    const reparsed = SshdServerConfig.parse(original.serialize());
    expect(reparsed.permitEmptyPasswords).toBe(true);
    expect(reparsed.loginGraceTimeSeconds).toBe(45);
    expect(reparsed.clientAliveIntervalSeconds).toBe(60);
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
