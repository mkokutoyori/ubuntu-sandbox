/**
 * PRD-Windows-Server.md §5 P4 — real WinRM network layer: a TCP/5985
 * listener opened by `winrm quickconfig`, and `Invoke-Command
 * -ComputerName`/`Test-WSMan`/`Enter-PSSession` gated by a real dial
 * (routing/cables/firewalls/service state), not a topology-wide lookup.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { resetCounters, IPAddress, SubnetMask } from '@/network/core/types';
import { WindowsPC } from '@/network/devices/WindowsPC';
import { WindowsServer } from '@/network/devices/WindowsServer';
import { GenericSwitch } from '@/network/devices/GenericSwitch';
import { Cable } from '@/network/hardware/Cable';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { PowerShellSubShell } from '@/terminal/subshells/PowerShellSubShell';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  Logger.reset();
});

const ps = (d: WindowsPC) => PowerShellSubShell.create(d).subShell;
const run = async (sh: ReturnType<typeof ps>, l: string) =>
  (await sh.processLine(l)).output.join('\n');

async function buildLan() {
  const srv = new WindowsServer('SRV1');
  const client = new WindowsPC('windows-pc', 'CLIENT1');
  const sw = new GenericSwitch('switch-generic', 'SW1');
  const cSrv = new Cable('c-srv'); cSrv.connect(srv.getPorts()[0], sw.getPorts()[0]);
  const cClient = new Cable('c-client'); cClient.connect(client.getPorts()[0], sw.getPorts()[1]);

  const mask = new SubnetMask('255.255.255.0');
  srv.getPorts()[0].configureIP(new IPAddress('192.168.20.10'), mask);
  client.getPorts()[0].configureIP(new IPAddress('192.168.20.20'), mask);
  client.addHostsEntry('192.168.20.10', 'SRV1');

  srv.setCurrentUser('Administrator');
  client.setCurrentUser('Administrator');

  return { srv, client, cSrv, cClient };
}

describe('winrm quickconfig', () => {
  it('opens the WinRM service and a listener on 5985', async () => {
    const { srv } = await buildLan();
    const before = await srv.executeCmdCommand('winrm enumerate winrm/config/listener');
    expect(before).toMatch(/No listeners/i);

    const out = await srv.executeCmdCommand('winrm quickconfig');
    expect(out).toMatch(/WinRM has been updated to receive requests/i);

    const after = await srv.executeCmdCommand('winrm enumerate winrm/config/listener');
    expect(after).toContain('Port = 5985');
  });

  it('reports already configured on a second run', async () => {
    const { srv } = await buildLan();
    await srv.executeCmdCommand('winrm quickconfig');
    const out = await srv.executeCmdCommand('winrm quickconfig');
    expect(out).toMatch(/already running/i);
  });
});

describe('Test-WSMan — real reachability, not a topology shortcut', () => {
  it('fails against a reachable host that has not run quickconfig', async () => {
    const { client } = await buildLan();
    const out = await run(ps(client), 'Test-WSMan -ComputerName SRV1');
    expect(out).toMatch(/WinRM cannot complete the operation/i);
  });

  it('succeeds once the target has run quickconfig', async () => {
    const { srv, client } = await buildLan();
    await srv.executeCmdCommand('winrm quickconfig');
    const out = await run(ps(client), 'Test-WSMan -ComputerName SRV1');
    expect(out).toContain('wsmid');
  });

  it('fails with the cable unplugged even though quickconfig ran', async () => {
    const { srv, client, cClient } = await buildLan();
    await srv.executeCmdCommand('winrm quickconfig');
    cClient.disconnect();
    const out = await run(ps(client), 'Test-WSMan -ComputerName SRV1');
    expect(out).toMatch(/WinRM cannot complete the operation/i);
  });
});

describe('Invoke-Command -ComputerName — real dial + auth', () => {
  it('runs the script block on the remote and tags PSComputerName', async () => {
    const { srv, client } = await buildLan();
    await srv.executeCmdCommand('winrm quickconfig');
    const out = await run(ps(client), 'Invoke-Command -ComputerName SRV1 -Credential bob -ScriptBlock { $env:COMPUTERNAME }');
    expect(out.trim()).toBe('SRV1');
  });

  it('fails when the target has not enabled WinRM', async () => {
    const { client } = await buildLan();
    const out = await run(ps(client), 'Invoke-Command -ComputerName SRV1 -Credential bob -ScriptBlock { 1 }');
    expect(out).toMatch(/WinRM cannot complete the operation/i);
  });

  it('fails with a bad password', async () => {
    const { srv, client } = await buildLan();
    await srv.executeCmdCommand('winrm quickconfig');
    const out = await run(ps(client), 'Invoke-Command -ComputerName SRV1 -Credential bob:wrongpassword -ScriptBlock { 1 }');
    expect(out).toMatch(/WinRM cannot complete the operation/i);
  });

  it('fails with the cable unplugged', async () => {
    const { srv, client, cClient } = await buildLan();
    await srv.executeCmdCommand('winrm quickconfig');
    cClient.disconnect();
    const out = await run(ps(client), 'Invoke-Command -ComputerName SRV1 -Credential bob -ScriptBlock { 1 }');
    expect(out).toMatch(/WinRM cannot complete the operation/i);
  });
});

describe('Enter-PSSession — real dial + auth (PowerShellSubShell interception)', () => {
  it('succeeds against a reachable, quickconfig-ed, correctly authenticated target', async () => {
    const { srv, client } = await buildLan();
    await srv.executeCmdCommand('winrm quickconfig');
    const sh = ps(client);
    const result = await sh.processLine('Enter-PSSession -ComputerName SRV1 -Credential bob');
    expect((result as { _enterRemotePS?: unknown })._enterRemotePS).toBeTruthy();
  });

  it('fails against an unreachable target without entering a session', async () => {
    const { client } = await buildLan();
    const sh = ps(client);
    const result = await sh.processLine('Enter-PSSession -ComputerName SRV1 -Credential bob');
    expect((result as { _enterRemotePS?: unknown })._enterRemotePS).toBeUndefined();
    expect(result.output.join('\n')).toMatch(/WinRM cannot complete the operation/i);
  });
});
