/**
 * PRD-Nslookup-Dig-Rndc-Runas.md §2.1.7/P14 — `Start-Process -Credential`.
 *
 * Mirrors GetCredentialIntegration.test.ts's broker-mocking style for the
 * real-PSCredential cases, and process-cmdlets-debug.test.ts's plain
 * PowerShellSubShell style for the legacy string-credential / regression
 * cases.
 */
import { describe, it, expect } from 'vitest';
import { WindowsPC } from '@/network/devices/WindowsPC';
import { PowerShellSubShell } from '@/terminal/subshells/PowerShellSubShell';
import type { InputHost, InputCompletion, StreamAttachOptions, StreamAttachment } from '@/shell/input';
import type { InputRequest } from '@/shell/input/types';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import { resetCounters } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';

function makeHost() {
  let pending: ((o: InputCompletion) => void) | null = null;
  const host: InputHost = {
    requestInput(req: InputRequest, complete) { pending = complete; },
    cancelRequest() { pending = null; },
    emit() {},
    attachStream(_opts: StreamAttachOptions): StreamAttachment {
      return { id: 'x', description: '', active: true, cancel() {} };
    },
    detachAllStreams() {},
    capabilities() { return { interactive: true, maskedSupported: true, streaming: true }; },
  };
  return {
    host,
    pump(value: string) { const cb = pending; pending = null; cb?.({ status: 'submitted', value }); },
  };
}

function setupWithBroker() {
  EquipmentRegistry.resetInstance();
  const pc = new WindowsPC('win-pc', 'WIN');
  pc.powerOn();
  const { subShell } = PowerShellSubShell.create(pc);
  const h = makeHost();
  subShell.setInputHost(h.host);
  return { subShell, h };
}

function createShell(): PowerShellSubShell {
  resetCounters();
  resetDeviceCounters();
  Logger.reset();
  const pc = new WindowsPC('windows-pc', 'WIN-PROC');
  pc.setCurrentUser('Administrator');
  return PowerShellSubShell.create(pc).subShell;
}
async function run(sh: PowerShellSubShell, line: string): Promise<string> {
  const r = await sh.processLine(line);
  return r.output.join('\n');
}

describe('Start-Process -Credential with a real PSCredential (from Get-Credential)', () => {
  it('launches the process under that identity when the password is correct', async () => {
    const { subShell, h } = setupWithBroker();
    const p = subShell.processLine('$cred = Get-Credential -UserName alice');
    await new Promise(r => setTimeout(r, 5));
    h.pump('alice');
    await p;

    const started = await subShell.processLine('Start-Process notepad.exe -Credential $cred');
    expect(started.output.join('')).not.toMatch(/incorrect|error/i);

    const proc = await subShell.processLine('Get-Process -Name notepad | Select-Object ProcessName,Owner');
    const out = proc.output.join('\n');
    expect(out).toContain('notepad');
    expect(out).toContain('alice');
  });

  it('fails with the real Windows error message and starts nothing when the password is wrong', async () => {
    const { subShell, h } = setupWithBroker();
    const p = subShell.processLine('$cred = Get-Credential -UserName alice');
    await new Promise(r => setTimeout(r, 5));
    h.pump('not-the-real-password');
    await p;

    const started = await subShell.processLine('Start-Process notepad.exe -Credential $cred');
    expect(started.output.join('')).toContain(
      'This command cannot be executed due to the error: The user name or password is incorrect.',
    );

    const proc = await subShell.processLine('Get-Process -Name notepad');
    expect(proc.output.join('')).toContain('Cannot find a process');
  });
});

describe('Start-Process -Credential with the legacy "user:password" string form', () => {
  it('still works and sets process ownership (backward compatibility)', async () => {
    const out = await run(createShell(), 'Start-Process notepad.exe -Credential "alice:alice"');
    expect(out).not.toMatch(/incorrect|error/i);
  });

  it('still rejects a wrong password with the real error message', async () => {
    const out = await run(createShell(), 'Start-Process notepad.exe -Credential "alice:wrongpw"');
    expect(out).toContain('The user name or password is incorrect.');
  });
});

describe('Start-Process without -Credential (regression)', () => {
  it('still starts a process retrievable via Get-Process, owned by the current user', async () => {
    const sh = createShell();
    await run(sh, 'Start-Process notepad.exe');
    const out = await run(sh, 'Get-Process -Name notepad | Select-Object ProcessName,Owner');
    expect(out).toContain('notepad');
    expect(out).toContain('Administrator');
  });

  it('-PassThru still emits the synthesized {Id, Name, Path} object', async () => {
    const out = await run(createShell(), 'Start-Process notepad.exe -PassThru');
    expect(out).toContain('notepad');
  });
});
