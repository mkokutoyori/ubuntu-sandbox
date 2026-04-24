/**
 * cmd-bat-execution.test.ts — TDD tests for .bat file execution in CmdSubShell.
 *
 * Covers:
 *   - Running a .bat file by name (with and without .bat extension)
 *   - `call script.bat` syntax
 *   - @echo off / @echo on  (suppress echoing)
 *   - REM and :: comments skipped
 *   - %1 %2 argument substitution
 *   - Missing file error
 *   - Multi-line output combined correctly
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { PowerShellSubShell } from '@/terminal/subshells/PowerShellSubShell';
import { CmdSubShell } from '@/terminal/subshells/CmdSubShell';
import { WindowsPC } from '@/network/devices/WindowsPC';
import { MACAddress, resetCounters } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  MACAddress.resetCounter();
  Logger.reset();
});

function createSetup(): { pc: WindowsPC; cmd: CmdSubShell } {
  const pc = new WindowsPC('windows-pc', 'PC1', 100, 100);
  pc.powerOn();
  const { subShell: cmd } = CmdSubShell.create(pc);
  return { pc, cmd };
}

async function run(cmd: CmdSubShell, line: string): Promise<string[]> {
  const r = await cmd.processLine(line);
  return r.output;
}

/** Write a .bat file into the device's cwd on the filesystem. */
function writeBat(pc: WindowsPC, name: string, content: string): void {
  const fs = pc.getFileSystem();
  const cwd: string = (pc as any).getCwd();
  fs.createFile(`${cwd}\\${name}`, content);
}

// ─── Basic execution ─────────────────────────────────────────────────────────

describe('CmdSubShell .bat execution', () => {

  it('runs a simple .bat file by name', async () => {
    const { pc, cmd } = createSetup();
    writeBat(pc, 'hello.bat', 'echo Hello from bat\r\necho Line two\r\n');
    const out = await run(cmd, 'hello.bat');
    expect(out.join('\n')).toContain('Hello from bat');
    expect(out.join('\n')).toContain('Line two');
  });

  it('runs a .bat file without the .bat extension', async () => {
    const { pc, cmd } = createSetup();
    writeBat(pc, 'greet.bat', 'echo greetings\r\n');
    const out = await run(cmd, 'greet');
    expect(out.join('\n')).toContain('greetings');
  });

  it('runs a .bat file via "call" syntax', async () => {
    const { pc, cmd } = createSetup();
    writeBat(pc, 'info.bat', 'echo called\r\n');
    const out = await run(cmd, 'call info.bat');
    expect(out.join('\n')).toContain('called');
  });

  it('skips REM comments', async () => {
    const { pc, cmd } = createSetup();
    writeBat(pc, 'rem.bat', 'REM this is a comment\r\necho visible\r\n');
    const out = await run(cmd, 'rem.bat');
    expect(out.join('\n')).not.toContain('this is a comment');
    expect(out.join('\n')).toContain('visible');
  });

  it('skips :: comments', async () => {
    const { pc, cmd } = createSetup();
    writeBat(pc, 'comment.bat', ':: another comment\r\necho ok\r\n');
    const out = await run(cmd, 'comment.bat');
    expect(out.join('\n')).not.toContain('another comment');
    expect(out.join('\n')).toContain('ok');
  });

  it('@echo off suppresses command echoing (output is still produced)', async () => {
    const { pc, cmd } = createSetup();
    writeBat(pc, 'silent.bat', '@echo off\r\necho result\r\n');
    const out = await run(cmd, 'silent.bat');
    expect(out.join('\n')).toContain('result');
  });

  it('substitutes %1 %2 arguments', async () => {
    const { pc, cmd } = createSetup();
    writeBat(pc, 'greet2.bat', 'echo Hello %1 and %2\r\n');
    const out = await run(cmd, 'greet2.bat Alice Bob');
    expect(out.join('\n')).toContain('Hello Alice and Bob');
  });

  it('returns an error for a missing .bat file', async () => {
    const { pc, cmd } = createSetup();
    void pc;
    const out = await run(cmd, 'missing.bat');
    const joined = out.join('\n').toLowerCase();
    expect(joined.includes('not recognized') || joined.includes('not found') || joined.includes('cannot find')).toBe(true);
  });

  it('returns an error for a missing file without extension', async () => {
    const { pc, cmd } = createSetup();
    void pc;
    const out = await run(cmd, 'nosuchscript');
    const joined = out.join('\n').toLowerCase();
    expect(joined.includes('not recognized') || joined.includes('not found')).toBe(true);
  });

  it('handles empty .bat file gracefully', async () => {
    const { pc, cmd } = createSetup();
    writeBat(pc, 'empty.bat', '');
    const out = await run(cmd, 'empty.bat');
    expect(out).toEqual([]);
  });

  it('handles blank lines inside .bat file', async () => {
    const { pc, cmd } = createSetup();
    writeBat(pc, 'blanks.bat', '\r\necho first\r\n\r\necho second\r\n');
    const out = await run(cmd, 'blanks.bat');
    expect(out.join('\n')).toContain('first');
    expect(out.join('\n')).toContain('second');
  });

  it('runs multiple commands and combines output', async () => {
    const { pc, cmd } = createSetup();
    writeBat(pc, 'multi.bat', 'echo one\r\necho two\r\necho three\r\n');
    const out = await run(cmd, 'multi.bat');
    const joined = out.join('\n');
    expect(joined).toContain('one');
    expect(joined).toContain('two');
    expect(joined).toContain('three');
  });
});
