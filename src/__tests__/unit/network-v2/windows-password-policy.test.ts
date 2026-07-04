/**
 * Windows — `net accounts` (LSA password policy) is actually enforced.
 *
 * Previously the policy state (minpwlen, uniquepw, lockoutthreshold,
 * lockoutduration) was stored and rendered by `net accounts` but never
 * consulted: `validatePasswordComplexity` hardcoded `length < 2`, password
 * history was never tracked, and `WindowsSecurityAudit.accountLockedOut`
 * (Security 4740) was never invoked from anywhere.
 */
import { describe, it, expect } from 'vitest';
import { WindowsPC } from '@/network/devices/WindowsPC';

function createPC(): WindowsPC {
  const pc = new WindowsPC('windows-pc', 'PC1', 0, 0);
  pc.setCurrentUser('Administrator');
  return pc;
}

describe('net accounts /minpwlen — minimum password length is enforced', () => {
  it('rejects a new user password shorter than the configured minimum', async () => {
    const pc = createPC();
    await pc.executeCommand('net accounts /minpwlen:8');
    const out = await pc.executeCommand('net user TestUser short /add');
    expect(out).toContain('does not meet the password policy requirements');
  });

  it('accepts a password meeting the configured minimum', async () => {
    const pc = createPC();
    await pc.executeCommand('net accounts /minpwlen:8');
    const out = await pc.executeCommand('net user TestUser longenough /add');
    expect(out).toContain('The command completed successfully');
  });

  it('rejects a too-short password on an existing-user password change too', async () => {
    const pc = createPC();
    await pc.executeCommand('net user TestUser initialpass /add');
    await pc.executeCommand('net accounts /minpwlen:8');
    const out = await pc.executeCommand('net user TestUser short');
    expect(out).toContain('does not meet the password policy requirements');
  });
});

describe('net accounts /uniquepw — password history is enforced', () => {
  it('rejects reusing the current password when history is enabled', async () => {
    const pc = createPC();
    await pc.executeCommand('net user TestUser FirstPass1 /add');
    await pc.executeCommand('net accounts /uniquepw:3');
    const out = await pc.executeCommand('net user TestUser FirstPass1');
    expect(out).toContain('does not meet the password policy requirements');
  });

  it('rejects reusing a password still within the retained history window', async () => {
    const pc = createPC();
    await pc.executeCommand('net user TestUser FirstPass1 /add');
    await pc.executeCommand('net accounts /uniquepw:2');
    await pc.executeCommand('net user TestUser SecondPass2');
    const out = await pc.executeCommand('net user TestUser FirstPass1');
    expect(out).toContain('does not meet the password policy requirements');
  });

  it('allows a brand-new password not present in history', async () => {
    const pc = createPC();
    await pc.executeCommand('net user TestUser FirstPass1 /add');
    await pc.executeCommand('net accounts /uniquepw:3');
    const out = await pc.executeCommand('net user TestUser BrandNewPass9');
    expect(out).toContain('The command completed successfully');
  });
});

describe('net accounts /lockoutthreshold — account lockout is enforced', () => {
  it('locks the account after the configured number of consecutive failures', async () => {
    const pc = createPC();
    await pc.executeCommand('net accounts /lockoutthreshold:3');
    // Default seed: 'user' / 'user'.
    expect(pc.checkPassword('user', 'wrong')).toBe(false);
    expect(pc.checkPassword('user', 'wrong')).toBe(false);
    expect(pc.checkPassword('user', 'wrong')).toBe(false);

    // The 4th attempt uses the CORRECT password but the account is locked.
    expect(pc.checkPassword('user', 'user')).toBe(false);
  });

  it('writes a Security 4740 (account locked out) event once the threshold is hit', async () => {
    const pc = createPC();
    await pc.executeCommand('net accounts /lockoutthreshold:2');
    pc.checkPassword('user', 'wrong');
    pc.checkPassword('user', 'wrong');

    const log = (pc.eventLog.getEntriesStructured('Security', { newest: 50 }) ?? []).map(e => e.eventId);
    expect(log).toContain(4740);
  });

  it('does not lock the account when lockoutthreshold is 0 (the default — never)', async () => {
    const pc = createPC();
    for (let i = 0; i < 10; i++) pc.checkPassword('user', 'wrong');
    expect(pc.checkPassword('user', 'user')).toBe(true);
  });

  it('a correct password before the threshold resets the failure counter', async () => {
    const pc = createPC();
    await pc.executeCommand('net accounts /lockoutthreshold:3');
    pc.checkPassword('user', 'wrong');
    pc.checkPassword('user', 'wrong');
    expect(pc.checkPassword('user', 'user')).toBe(true);
    // Two more wrong attempts should not lock — the counter was reset.
    pc.checkPassword('user', 'wrong');
    pc.checkPassword('user', 'wrong');
    expect(pc.checkPassword('user', 'user')).toBe(true);
  });

  it('re-enabling the account via /active:yes clears the lockout', async () => {
    const pc = createPC();
    await pc.executeCommand('net accounts /lockoutthreshold:2');
    pc.checkPassword('user', 'wrong');
    pc.checkPassword('user', 'wrong');
    expect(pc.checkPassword('user', 'user')).toBe(false);

    await pc.executeCommand('net user user /active:yes');
    expect(pc.checkPassword('user', 'user')).toBe(true);
  });
});
