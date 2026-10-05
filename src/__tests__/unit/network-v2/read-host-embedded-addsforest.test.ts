/*
 * Probe — `Read-Host` is a cmdlet, and a `(Read-Host -AsSecureString "…")`
 * nested inside another command is prompted for interactively before that
 * command runs, so its answer reaches the outer parameter.
 *
 * Before: `Install-ADDSForest … -SafeModeAdministratorPassword (Read-Host
 * -AsSecureString "Entrez le mot de passe DSRM") -Force` answered "The term
 * 'read-host' is not recognized as the name of a cmdlet". Read-Host was
 * intercepted at the sub-shell only when it was the WHOLE line ($x =
 * Read-Host / bare Read-Host); nested in a sub-expression it slipped past
 * the interception and reached the interpreter, which had no such cmdlet.
 *
 * Authority: PowerShell `Read-Host [-Prompt] <string> [-AsSecureString]`
 * (about_Read-Host) reads a line from the console and, with
 * -AsSecureString, returns a SecureString. A parenthesised sub-expression
 * evaluates first, so the prompt happens before the outer cmdlet binds its
 * parameter — the sub-shell owns the interactive broker (the interpreter
 * does not), so the nested call is resolved there and its answer is
 * substituted through the existing ConvertTo-SecureString shape that
 * Install-ADDSForest already unwraps.
 *
 * Measured before the change (git stash of src/terminal + src/powershell):
 * 3 of the 4 cases fail.
 * Passing either way:
 *   - "a top-level Read-Host still prompts and returns" is the WITNESS: the
 *     broker and the sub-shell interception are sound, so the nested cases
 *     measure the new resolution and not a dead broker.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { resetCounters, IPAddress, SubnetMask } from '@/network/core/types';
import { WindowsServer } from '@/network/devices/WindowsServer';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { PowerShellSubShell } from '@/terminal/subshells/PowerShellSubShell';
import type { InputHost, InputCompletion } from '@/shell/input';
import type { InputRequest } from '@/shell/input/types';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  Logger.reset();
});

function makeHost() {
  let pending: ((o: InputCompletion) => void) | null = null;
  const prompts: string[] = [];
  const modes: ('password' | 'text')[] = [];
  const host: InputHost = {
    requestInput(req: InputRequest, complete) {
      prompts.push(req.prompt);
      modes.push(req.kind === 'password' || req.mask === true || req.echo === false ? 'password' : 'text');
      pending = complete;
    },
    cancelRequest() { pending = null; },
    emit() {},
    attachStream() { return { id: 'x', description: '', active: true, cancel() {} }; },
    detachAllStreams() {},
    capabilities() { return { interactive: true, maskedSupported: true, streaming: true }; },
  };
  return {
    host, prompts, modes,
    pump(value: string) { const cb = pending; pending = null; cb?.({ status: 'submitted', value }); },
  };
}

function dc(): { server: WindowsServer; sh: ReturnType<typeof PowerShellSubShell.create>['subShell']; h: ReturnType<typeof makeHost> } {
  const server = new WindowsServer('DC01');
  server.getPorts()[0].configureIP(new IPAddress('192.168.10.10'), new SubnetMask('255.255.255.0'));
  server.setCurrentUser('Administrator');
  const sh = PowerShellSubShell.create(server).subShell;
  const h = makeHost();
  sh.setInputHost(h.host);
  return { server, sh, h };
}

async function line(sh: ReturnType<typeof PowerShellSubShell.create>['subShell'], l: string): Promise<string> {
  return (await sh.processLine(l)).output.join('\n');
}

describe('Read-Host nested in Install-ADDSForest', () => {
  it('a top-level Read-Host still prompts and returns', async () => {
    const { sh, h } = dc();
    const p = sh.processLine('Read-Host -AsSecureString -Prompt "Password"');
    await new Promise(r => setTimeout(r, 5));
    expect(h.modes[0]).toBe('password');
    h.pump('s3cret');
    expect((await p).output.join('')).toBe('s3cret');
  });

  it('Read-Host is a recognised cmdlet', async () => {
    const { sh } = dc();
    const out = await line(sh, 'Get-Command Read-Host');
    expect(out).not.toMatch(/not recognized/i);
    expect(out).toMatch(/Read-Host/);
  });

  it('a nested (Read-Host -AsSecureString) is prompted for and promotes the forest', async () => {
    const { server, sh, h } = dc();
    await line(sh, 'Install-WindowsFeature -Name AD-Domain-Services -IncludeManagementTools');
    const p = sh.processLine(
      'Install-ADDSForest -DomainName "google.com" -DomainNetbiosName "GOOGLE" '
      + '-SafeModeAdministratorPassword (Read-Host -AsSecureString "Entrez le mot de passe DSRM") -Force');
    await new Promise(r => setTimeout(r, 5));
    expect(h.modes[0]).toBe('password');
    expect(h.prompts[0]).toBe('Entrez le mot de passe DSRM: ');
    h.pump('DSRM@Google2025!');
    const out = (await p).output.join('\n');
    expect(out).not.toMatch(/not recognized/i);
    expect(server.getDirectoryStore()).not.toBeNull();
    expect(await line(sh, '(Get-ADDomain).DNSRoot')).toMatch(/google\.com/i);
  });

  it('a nested (Read-Host) with no -AsSecureString substitutes a plain string', async () => {
    const { sh, h } = dc();
    const p = sh.processLine('Write-Output (Read-Host -Prompt "Name")');
    await new Promise(r => setTimeout(r, 5));
    expect(h.modes[0]).toBe('text');
    h.pump('Alice');
    expect((await p).output.join('')).toBe('Alice');
  });
});
