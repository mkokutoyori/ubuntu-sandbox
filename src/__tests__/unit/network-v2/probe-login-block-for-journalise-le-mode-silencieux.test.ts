/**
 * Probe: `login block-for` writes the two syslog lines the IOS Security
 * Command Reference documents for the quiet period
 * (official_docs/cisco/ios-security, "login block-for", System Logging
 * Messages): %SEC_LOGIN-1-QUIET_MODE_ON when the failures reach the
 * threshold and %SEC_LOGIN-5-QUIET_MODE_OFF when the block period times out.
 *
 * Measured with src/network stashed: neither mnemonic existed, so all 4 cases
 * fall (the audit log only knew LOGIN_FAILED).
 *
 *   fall before : 'ON is written once, when the threshold is reached'
 *   fall before : 'ON carries the user, the source and the reason'
 *   fall before : 'OFF is written when the block period times out'
 *   fall before : 'further failures inside the quiet period do not repeat ON'
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { EventBus } from '@/events/EventBus';
import { LoginBlocker } from '@/network/devices/router/aaa/LoginBlocker';
import { SecurityAuditLog } from '@/network/devices/router/aaa/SecurityAuditLog';
import { NetworkOsCredentialStore } from '@/network/devices/router/aaa/NetworkOsCredentialStore';
import { NetworkOsAccount } from '@/network/devices/router/aaa/NetworkOsAccount';

describe('login block-for: quiet-mode syslog lines', () => {
  let store: NetworkOsCredentialStore;
  let audit: SecurityAuditLog;
  let blocker: LoginBlocker;
  let now: number;

  beforeEach(() => {
    const bus = new EventBus();
    now = Date.UTC(2003, 1, 26, 16, 17, 23);
    store = new NetworkOsCredentialStore({ deviceId: 'r1', bus });
    audit = new SecurityAuditLog({ deviceId: 'r1', bus, now: () => now });
    blocker = new LoginBlocker({
      deviceId: 'r1', bus, attempts: 2, withinSeconds: 30, blockSeconds: 60, now: () => now,
      onQuietMode: (change) => audit.recordQuietMode(change),
    });
    store.upsert(NetworkOsAccount.create({ name: 'sfd' }));
  });

  const quiet = (mnemonic: string) => audit.entries().filter((e) => e.mnemonic === mnemonic);

  it('ON is written once, when the threshold is reached', () => {
    store.recordLoginFailure('sfd', '10.4.2.11', 'Invalid login', now);
    expect(quiet('QUIET_MODE_ON')).toHaveLength(0);
    store.recordLoginFailure('sfd', '10.4.2.11', 'Invalid login', now + 1000);
    expect(quiet('QUIET_MODE_ON')).toHaveLength(1);
  });

  it('ON carries the user, the source and the reason', () => {
    store.recordLoginFailure('sfd', '10.4.2.11', 'Invalid login', now);
    store.recordLoginFailure('sfd', '10.4.2.11', 'Invalid login', now + 1000);
    const [entry] = quiet('QUIET_MODE_ON');
    expect(entry.facility).toBe('SEC_LOGIN');
    expect(entry.severity).toBe(1);
    expect(entry.message).toMatch(
      /^Still timeleft for watching failures is \d+ seconds, \[user:sfd\] \[Source:10\.4\.2\.11\] \[localport:22\] \[Reason:Invalid login\], \[ACL:sl_def_acl\] at 16:17:24 UTC Wed Feb 26 2003$/);
  });

  it('OFF is written when the block period times out', () => {
    store.recordLoginFailure('sfd', '10.4.2.11', 'Invalid login', now);
    store.recordLoginFailure('sfd', '10.4.2.11', 'Invalid login', now + 1000);
    expect(blocker.isBlocked(undefined, now + 30_000)).toBe(true);
    expect(quiet('QUIET_MODE_OFF')).toHaveLength(0);
    expect(blocker.isBlocked(undefined, now + 62_000)).toBe(false);
    const [entry] = quiet('QUIET_MODE_OFF');
    expect(entry.severity).toBe(5);
    expect(entry.message).toBe('Quiet Mode is OFF, because block period timed out at 16:18:24 UTC Wed Feb 26 2003');
  });

  it('further failures inside the quiet period do not repeat ON', () => {
    store.recordLoginFailure('sfd', '10.4.2.11', 'Invalid login', now);
    store.recordLoginFailure('sfd', '10.4.2.11', 'Invalid login', now + 1000);
    store.recordLoginFailure('sfd', '10.4.2.11', 'Invalid login', now + 2000);
    expect(quiet('QUIET_MODE_ON')).toHaveLength(1);
  });
});
