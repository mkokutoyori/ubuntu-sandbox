/**
 * PRD-Nslookup-Dig-Rndc-Runas.md §2.1.6/P11 — `runas`'s real interactive
 * password prompt, driven the same way a React view would
 * (`session.foreground.setInput(...)` + Enter), mirroring
 * `cross-vendor-ssh-interactive.test.ts`'s UI-level testing style. The
 * pre-existing non-interactive `pc.executeCommand('runas ...')` path
 * (windows-access-cmd.test.ts) is untouched — this only covers the new,
 * terminal-driven prompt.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { WindowsPC } from '@/network/devices/WindowsPC';
import { resetCounters } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { WindowsTerminalSession } from '@/terminal/sessions/WindowsTerminalSession';
import type { KeyEvent, TerminalSession } from '@/terminal/sessions/TerminalSession';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  Logger.reset();
});

function key(k: string, opts: { ctrlKey?: boolean } = {}): KeyEvent {
  return { key: k, ctrlKey: opts.ctrlKey ?? false, altKey: false, metaKey: false, shiftKey: false };
}

async function flush(times = 8): Promise<void> {
  for (let i = 0; i < times; i++) {
    await Promise.resolve();
    await new Promise<void>((r) => setTimeout(r, 0));
  }
}

async function type(session: TerminalSession, line: string): Promise<void> {
  const fg = session.foreground;
  fg.setInput(line);
  fg.setInputBuf(line);
  session.handleKey(key('Enter'));
  await flush();
}

function linesOf(session: TerminalSession): string[] {
  return session.lines.map((l) => l.text);
}

function expectContains(session: TerminalSession, needle: string | RegExp): void {
  const ls = linesOf(session);
  const hit = ls.some((l) => (needle instanceof RegExp ? needle.test(l) : l.includes(needle)));
  if (!hit) {
    throw new Error(`Expected terminal to contain ${String(needle)}\n--- actual ---\n${ls.join('\n')}\n---`);
  }
}

function buildSession(): { pc: WindowsPC; term: WindowsTerminalSession } {
  const pc = new WindowsPC('windows-pc', 'WIN-PC1');
  const term = new WindowsTerminalSession('w1', pc);
  return { pc, term };
}

describe('runas interactive password prompt (PRD-Nslookup-Dig-Rndc-Runas.md P11)', () => {
  it('prompts for the password, then succeeds and runs the program as the target user', async () => {
    const { term } = buildSession();
    await term.init();

    await type(term, 'runas /user:Administrator whoami');
    expect(term.currentInputMode.type).toBe('password');
    expectContains(term, 'Enter the password for Administrator:');

    term.setPasswordBuf('admin');
    term.handleKey(key('Enter'));
    await flush();

    expectContains(term, /administrator/i);
    expect(term.currentInputMode.type).toBe('normal');
  });

  it('a wrong password fails with the real runas error message, no retry prompt', async () => {
    const { term } = buildSession();
    await term.init();

    await type(term, 'runas /user:Administrator whoami');
    term.setPasswordBuf('not-the-password');
    term.handleKey(key('Enter'));
    await flush();

    expectContains(term, 'RUNAS ERROR: Unable to run - whoami.');
    expectContains(term, '1326: The user name or password is incorrect.');
    expect(term.currentInputMode.type).toBe('normal');
  });

  it('an unrecognized account is rejected immediately, with no password prompt at all', async () => {
    const { term } = buildSession();
    await term.init();

    await type(term, 'runas /user:NonExistent whoami');

    expect(term.currentInputMode.type).toBe('normal');
    expectContains(term, 'RUNAS ERROR: The user name "NonExistent" is not recognized.');
  });

  it('a disabled account is rejected immediately, with no password prompt at all', async () => {
    const { term } = buildSession();
    await term.init();

    // Guest is disabled by default in this simulator's SAM database.
    await type(term, 'runas /user:Guest whoami');

    expect(term.currentInputMode.type).toBe('normal');
    expectContains(term, 'RUNAS ERROR: The account "Guest" is disabled.');
  });

  it('Ctrl+C cancels the password challenge without running anything', async () => {
    const { term } = buildSession();
    await term.init();

    await type(term, 'runas /user:Administrator whoami');
    expect(term.currentInputMode.type).toBe('password');

    term.handleKey(key('c', { ctrlKey: true }));
    await flush();

    expect(term.currentInputMode.type).toBe('normal');
    expectContains(term, '^C');
  });

  it('the pre-existing non-interactive executeCommand path is unaffected', async () => {
    const { pc } = buildSession();

    const out = await pc.executeCommand('runas /user:Administrator whoami');

    expect(out.toLowerCase()).toContain('administrator');
  });
});

describe('runas /netonly (PRD-Nslookup-Dig-Rndc-Runas.md P12)', () => {
  it('never prompts and runs the command as the caller, not the named account', async () => {
    const { term } = buildSession();
    await term.init();

    await type(term, 'runas /netonly /user:NonExistent whoami');

    expect(term.currentInputMode.type).toBe('normal');
    expectContains(term, /\\user$/i);
  });

  it('does not validate the account against the local SAM at all', async () => {
    const { pc } = buildSession();

    const out = await pc.executeCommand('runas /netonly /user:SomeDomainAccount whoami');

    expect(out.toLowerCase()).not.toContain('is not recognized');
    expect(out.toLowerCase()).toMatch(/\\user$/);
  });
});

describe('runas /savecred (PRD-Nslookup-Dig-Rndc-Runas.md P12)', () => {
  it('prompts the first time, then skips the prompt on a later invocation', async () => {
    const { term } = buildSession();
    await term.init();

    await type(term, 'runas /savecred /user:Administrator whoami');
    expect(term.currentInputMode.type).toBe('password');
    term.setPasswordBuf('admin');
    term.handleKey(key('Enter'));
    await flush();
    expectContains(term, /administrator/i);

    const linesBefore = term.lines.length;
    await type(term, 'runas /savecred /user:Administrator whoami');
    // No password prompt this time — straight to execution.
    expect(term.currentInputMode.type).toBe('normal');
    expect(term.lines.length).toBeGreaterThan(linesBefore);
    expectContains(term, /administrator/i);
  });

  it('does not save the credential on a failed attempt', async () => {
    const { pc, term } = buildSession();
    await term.init();

    await type(term, 'runas /savecred /user:Administrator whoami');
    term.setPasswordBuf('wrong');
    term.handleKey(key('Enter'));
    await flush();
    expectContains(term, '1326: The user name or password is incorrect.');

    expect(pc.getSavedRunasCredential('Administrator')).toBeNull();
  });
});
