import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxTerminalSession } from '@/terminal/sessions/LinuxTerminalSession';
import { LinuxPC } from '@/network/devices/LinuxPC';
import type { ISubShell } from '@/terminal/subshells/ISubShell';
import { MACAddress, resetCounters } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';

type SessionHandle = {
  handleKey(e: { key: string; ctrlKey?: boolean; shiftKey?: boolean }): boolean;
  setInputBuf(v: string): void;
  getInputBuf(): string;
  activeSubShell: ISubShell | null;
};

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  MACAddress.resetCounter();
});

function sessionWithSubShell(sub: ISubShell): SessionHandle {
  const pc = new LinuxPC('linux-pc', 'PC1');
  const s = new LinuxTerminalSession('t1', pc) as unknown as SessionHandle;
  s.activeSubShell = sub;
  return s;
}

function fakeSubShell(candidates: string[] | undefined): ISubShell {
  const sub: ISubShell = {
    kind: 'sqlplus',
    connection: 'subshell',
    getPrompt: () => 'SQL> ',
    handleKey: () => false,
    processLine: () => ({ output: [], exit: false, prompt: 'SQL> ' }),
    dispose: () => undefined,
  };
  if (candidates !== undefined) {
    sub.getCompletions = () => candidates;
  }
  return sub;
}

describe('Tab inside a Linux-hosted sub-shell (PRD item 1 — dead branch fix)', () => {
  it('consumes Tab even when the sub-shell has no getCompletions (no browser focus leak)', () => {
    const s = sessionWithSubShell(fakeSubShell(undefined));
    s.setInputBuf('sel');
    expect(s.handleKey({ key: 'Tab' })).toBe(true);
    expect(s.getInputBuf()).toBe('sel');
  });

  it('unique candidate completes the token inline', () => {
    const s = sessionWithSubShell(fakeSubShell(['SELECT']));
    s.setInputBuf('SEL');
    expect(s.handleKey({ key: 'Tab' })).toBe(true);
    expect(s.getInputBuf()).toBe('SELECT');
  });

  it('repeated Tab cycles through ambiguous candidates and wraps', () => {
    const s = sessionWithSubShell(fakeSubShell(['SELECT', 'SET']));
    s.setInputBuf('SE');
    s.handleKey({ key: 'Tab' });
    expect(s.getInputBuf()).toBe('SELECT');
    s.handleKey({ key: 'Tab' });
    expect(s.getInputBuf()).toBe('SET');
    s.handleKey({ key: 'Tab' });
    expect(s.getInputBuf()).toBe('SELECT');
  });

  it('Shift+Tab cycles backward', () => {
    const s = sessionWithSubShell(fakeSubShell(['SELECT', 'SET', 'SHOW']));
    s.setInputBuf('S');
    s.handleKey({ key: 'Tab' });
    s.handleKey({ key: 'Tab' });
    expect(s.getInputBuf()).toBe('SET');
    s.handleKey({ key: 'Tab', shiftKey: true });
    expect(s.getInputBuf()).toBe('SELECT');
  });

  it('completion only replaces the last word, keeping the left of the line', () => {
    const s = sessionWithSubShell(fakeSubShell(['employees']));
    s.setInputBuf('SELECT * FROM emp');
    s.handleKey({ key: 'Tab' });
    expect(s.getInputBuf()).toBe('SELECT * FROM employees');
  });

  it('existing sub-shell keys still work after the Tab branch (Ctrl+L, Ctrl+C, arrows)', () => {
    const s = sessionWithSubShell(fakeSubShell(['SELECT']));
    s.setInputBuf('abc');
    expect(s.handleKey({ key: 'c', ctrlKey: true })).toBe(true);
    expect(s.getInputBuf()).toBe('');
    expect(s.handleKey({ key: 'l', ctrlKey: true })).toBe(true);
    expect(s.handleKey({ key: 'ArrowUp' })).toBe(true);
    expect(s.handleKey({ key: 'ArrowDown' })).toBe(true);
  });

  it('real flow: nslookup interactive sub-shell consumes Tab as a no-op', async () => {
    const pc = new LinuxPC('linux-pc', 'PC2');
    const s = new LinuxTerminalSession('t2', pc) as unknown as SessionHandle & {
      executeCommand(line: string): Promise<void>;
    };
    await s.executeCommand('nslookup');
    expect(s.activeSubShell).not.toBeNull();
    s.setInputBuf('ser');
    expect(s.handleKey({ key: 'Tab' })).toBe(true);
    expect(s.getInputBuf()).toBe('ser');
  });
});
