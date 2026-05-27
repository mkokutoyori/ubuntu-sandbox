/**
 * §WA1 Windows Security event log records SSH logon attempts.
 *
 * Today the WindowsSshServerContext auth path validates passwords /
 * keys silently — `wevtutil qe Security` shows nothing for the SSH
 * gate, even though every other Windows logon flow ends up there as
 * event 4624 (success) or 4625 (failure). This file pins the
 * behaviour we want: each inbound SSH auth attempt MUST produce the
 * matching Security event so an operator running `wevtutil qe
 * Security /c:50 /f:text` after the fact sees who got in and who
 * tried but failed.
 */
import { describe, it, expect } from 'vitest';
import { WindowsPC } from '@/network/devices/WindowsPC';

describe('§WA1 — Windows SSH publishes 4624/4625 to the Security event log', () => {
  it('publishes a successful logon (4624) when SSH password auth succeeds', () => {
    const pc = new WindowsPC('windows-pc', 'PC1', 0, 0);
    const ctx = pc.getSshServerContext();
    // Default WindowsUserManager seed: password for 'user' is 'user'.

    // Drive the auth path the way SshServerHandler would.
    expect(ctx.auth.checkPassword('user', 'user')).toBe(true);

    const log = (pc.eventLog.getEntriesStructured('Security', { newest: 50 }) ?? []).map(e => e.eventId);
    expect(log).toContain(4624);
  });

  it('publishes a failure event (4625) when SSH password auth is wrong', () => {
    const pc = new WindowsPC('windows-pc', 'PC1', 0, 0);
    const ctx = pc.getSshServerContext();
    // Default WindowsUserManager seed: password for 'user' is 'user'.

    expect(ctx.auth.checkPassword('user', 'WRONG')).toBe(false);

    const log = (pc.eventLog.getEntriesStructured('Security', { newest: 50 }) ?? []).map(e => e.eventId);
    expect(log).toContain(4625);
  });

  it('uses Logon Type 10 (RemoteInteractive) — that is what Windows logs for SSH', () => {
    const pc = new WindowsPC('windows-pc', 'PC1', 0, 0);
    const ctx = pc.getSshServerContext();
    // Default WindowsUserManager seed: password for 'user' is 'user'.

    ctx.auth.checkPassword('user', 'user');
    const entries = (pc.eventLog.getEntriesStructured('Security', { newest: 50 }) ?? [])
      .filter(e => e.eventId === 4624);
    expect(entries.length).toBeGreaterThan(0);
    expect(entries[0].message).toContain('Logon Type:\t\t10');
  });
});
