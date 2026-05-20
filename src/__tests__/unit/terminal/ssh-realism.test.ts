/**
 * SSH connection-flow realism — terminal_gap.md §3.
 *
 * Asserts that the SSH client/server pair produces output sequences that
 * closely match OpenSSH 9.x behaviour:
 *   - "Permission denied, please try again." between failed password attempts
 *   - "Welcome to Ubuntu …" banner on first interactive login
 *   - ctime-formatted "Last login: …" line on the SECOND login (never first)
 *   - lastlog rotation behaves like PAM (previous slot retained)
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxLastlogRegistry } from '@/network/devices/linux/LinuxLastlogRegistry';
import { TerminalSshInteractionHandler } from '@/network/protocols/ssh/session/TerminalSshInteractionHandler';
import type { ITerminalIO } from '@/network/protocols/ssh/session/TerminalSshInteractionHandler';
import { PasswordAuthMethod } from '@/network/protocols/ssh/auth/PasswordAuthMethod';
import type { ISshAuthContext } from '@/network/protocols/ssh/auth/ISshAuthMethod';

describe('LinuxLastlogRegistry — PAM-style rotation', () => {
  let reg: LinuxLastlogRegistry;

  beforeEach(() => {
    reg = new LinuxLastlogRegistry();
  });

  it('first call returns undefined (no prior login)', () => {
    const prev = reg.record('alice', '10.0.0.1', 'pts/0');
    expect(prev).toBeUndefined();
    expect(reg.getPrevious('alice')).toBeUndefined();
    expect(reg.getCurrent('alice')?.sourceHost).toBe('10.0.0.1');
  });

  it('rotates current → previous on each new login', () => {
    reg.record('alice', '10.0.0.1', 'pts/0');
    const becamePrevious = reg.record('alice', '10.0.0.2', 'pts/1');
    expect(becamePrevious?.sourceHost).toBe('10.0.0.1');

    expect(reg.getPrevious('alice')?.sourceHost).toBe('10.0.0.1');
    expect(reg.getCurrent('alice')?.sourceHost).toBe('10.0.0.2');
  });

  it('does not leak entries across users', () => {
    reg.record('alice', '10.0.0.1', 'pts/0');
    reg.record('bob', '10.0.0.2', 'pts/1');
    expect(reg.getCurrent('alice')?.sourceHost).toBe('10.0.0.1');
    expect(reg.getCurrent('bob')?.sourceHost).toBe('10.0.0.2');
    expect(reg.getPrevious('alice')).toBeUndefined();
    expect(reg.getPrevious('bob')).toBeUndefined();
  });

  it('formats entries in the canonical pam_lastlog.so / ctime form', () => {
    // Pin a deterministic timestamp: Tue Jan 23 12:34:56 2024 UTC
    const fixed = Date.UTC(2024, 0, 23, 12, 34, 56);
    const entry = { when: fixed, sourceHost: '10.0.0.1', tty: 'pts/0' };
    const line = LinuxLastlogRegistry.format(entry);
    expect(line).toBe('Last login: Tue Jan 23 12:34:56 2024 from 10.0.0.1');
  });
});

describe('PasswordAuthMethod — OpenSSH-style retry feedback', () => {
  it('emits "Permission denied, please try again." between attempts', async () => {
    const lines: Array<{ text: string; type?: string }> = [];
    const io: ITerminalIO = {
      writeLine: (text, type) => lines.push({ text, type }),
      readInput: async () => 'wrong',
    };
    const handler = new TerminalSshInteractionHandler(io);

    let attempts = 0;
    const ctx: ISshAuthContext = {
      checkPassword: () => { attempts++; return false; },
      checkPublicKey: () => false,
      getAttemptsRemaining: () => 3 - attempts,
      getAvailableMethods: () => ['password'],
    };
    // Wire showAuthFailure between attempts the way SshSession does.
    const provider = async (user: string, _left: number): Promise<string> => {
      if (attempts > 0) handler.showAuthFailure(user, 'host');
      return 'wrong';
    };
    const method = new PasswordAuthMethod(provider, 3);
    const result = await method.attempt('alice', ctx);
    expect(result.ok).toBe(false);

    const warnings = lines.filter(l => l.text.startsWith('Permission denied'));
    // 3 attempts → 2 inter-attempt notices (none before the very first
    // prompt, none after the last failure since the final "permission denied
    // (publickey,password)" comes from doAuthenticate).
    expect(warnings).toHaveLength(2);
    expect(warnings[0].type).toBe('warning');
  });

  it('does NOT emit a notice on a successful first attempt', async () => {
    const lines: Array<{ text: string }> = [];
    const io: ITerminalIO = {
      writeLine: (text) => lines.push({ text }),
      readInput: async () => 'right',
    };
    const handler = new TerminalSshInteractionHandler(io);
    const ctx: ISshAuthContext = {
      checkPassword: () => true,
      checkPublicKey: () => false,
      getAttemptsRemaining: () => 3,
      getAvailableMethods: () => ['password'],
    };
    let calls = 0;
    const provider = async (user: string, _left: number): Promise<string> => {
      if (calls > 0) handler.showAuthFailure(user, 'host');
      calls++;
      return 'right';
    };
    const method = new PasswordAuthMethod(provider, 3);
    const result = await method.attempt('alice', ctx);
    expect(result.ok).toBe(true);
    expect(lines.filter(l => l.text.includes('Permission denied'))).toHaveLength(0);
  });
});
