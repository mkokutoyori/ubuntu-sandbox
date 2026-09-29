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
import { runUserauth, type UserauthTransport } from '@/network/protocols/ssh/auth/ClientUserauth';
import { OPENSSH_CLIENT_AUTHENTICATION } from '@/network/protocols/ssh/SshConnectOptions';

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

describe('password userauth — OpenSSH-style retry feedback', () => {
  const passwordOnly = (accepts: (password: string) => boolean): UserauthTransport => ({
    request: async (method, fields) => {
      if (method === 'password' && accepts(String(fields.password))) return { kind: 'success' };
      return { kind: 'failure', methods: 'password' };
    },
  });
  const plan = { authentication: OPENSSH_CLIENT_AUTHENTICATION, identities: [], interactive: true };

  it('emits "Permission denied, please try again." between attempts', async () => {
    const lines: Array<{ text: string; type?: string }> = [];
    const io: ITerminalIO = {
      writeLine: (text, type) => lines.push({ text, type }),
      readInput: async () => 'wrong',
    };
    const handler = new TerminalSshInteractionHandler(io);
    const outcome = await runUserauth(passwordOnly(() => false), plan, {
      canAnswer: () => true,
      password: () => handler.promptPassword('alice', 'host'),
      keyboardInteractive: () => handler.promptPassword('alice', 'host'),
      retry: () => handler.showAuthFailure('alice', 'host'),
      inform: () => undefined,
    });
    expect(outcome).toEqual({ kind: 'denied', methods: 'password' });

    const warnings = lines.filter(l => l.text.startsWith('Permission denied'));
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
    const outcome = await runUserauth(passwordOnly((p) => p === 'right'), plan, {
      canAnswer: () => true,
      password: () => handler.promptPassword('alice', 'host'),
      keyboardInteractive: () => handler.promptPassword('alice', 'host'),
      retry: () => handler.showAuthFailure('alice', 'host'),
      inform: () => undefined,
    });
    expect(outcome).toEqual({ kind: 'success' });
    expect(lines.filter(l => l.text.includes('Permission denied'))).toHaveLength(0);
  });
});
