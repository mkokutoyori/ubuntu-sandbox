/**
 * Regression tests for cmd builtins that were "not recognized" in the
 * coherence-* debug runs. We only assert that each command produces
 * output (or persists a side effect) — not the exact text, since the
 * real cmd.exe output is very long and we only need behavior that
 * keeps existing scripts from crashing.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { WindowsPC } from '@/network/devices/WindowsPC';
import { resetCounters } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  Logger.reset();
});

function pc(): WindowsPC {
  const p = new WindowsPC('windows-pc', 'WIN-CMD');
  p.setCurrentUser('Administrator');
  return p;
}

describe('cmd: net <subcommand>', () => {
  it('net help → top-level help', async () => {
    const out = await pc().executeCmdCommand('net help');
    expect(out).toContain('NET ');
    expect(out).not.toContain('not recognized');
  });

  it('net help user → topic-specific syntax line', async () => {
    const out = await pc().executeCmdCommand('net help user');
    expect(out.toUpperCase()).toContain('NET USER');
    expect(out).not.toContain('not recognized');
  });

  it('net (no args) → top-level usage', async () => {
    const out = await pc().executeCmdCommand('net');
    expect(out).toContain('NET');
    expect(out).not.toContain('not recognized');
  });
});

describe('cmd: start / setx / schtasks / nbtstat / wmic / reg', () => {
  it('start <program> → silent', async () => {
    const out = await pc().executeCmdCommand('start notepad.exe');
    expect(out).toBe('');
  });

  it('setx VAR VALUE → SUCCESS and persists', async () => {
    const p = pc();
    const out = await p.executeCmdCommand('setx DBG_PERSIST_CMD "hello-cmd"');
    expect(out).toMatch(/SUCCESS/i);
    const read = await p.executeCmdCommand('set DBG_PERSIST_CMD');
    expect(read).toContain('hello-cmd');
  });

  it('schtasks /query → empty header table', async () => {
    const out = await pc().executeCmdCommand('schtasks /query');
    expect(out).toContain('TaskName');
    expect(out).not.toContain('not recognized');
  });

  it('nbtstat -n → local NetBIOS name table with hostname', async () => {
    const out = await pc().executeCmdCommand('nbtstat -n');
    expect(out.toUpperCase()).toContain('WIN-CMD');
    expect(out).toContain('NetBIOS Local Name Table');
  });

  it('wmic logicaldisk get name → C:', async () => {
    const out = await pc().executeCmdCommand('wmic logicaldisk get name');
    expect(out).toContain('C:');
    expect(out).not.toContain('not recognized');
  });

  it('reg query <key> → acknowledged', async () => {
    const out = await pc().executeCmdCommand('reg query HKCU\\Software\\CohReg');
    expect(out).toContain('HKCU\\Software\\CohReg');
    expect(out).not.toContain('not recognized');
  });

  it('reg add <key> /f → success message', async () => {
    const out = await pc().executeCmdCommand('reg add HKCU\\Software\\CohReg /f');
    expect(out).toMatch(/completed successfully/i);
  });
});
