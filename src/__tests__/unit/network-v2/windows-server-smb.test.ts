/**
 * PRD-Windows-Server.md §5 P3 — real SMB file server, acceptance
 * criterion 3 (§8): `net use` mounts a share across the real network,
 * `copy` from the mapped drive works, a user without share permission
 * is refused (error 5), the session appears in `Get-SmbSession` on the
 * server, and nothing works with the cable unplugged.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { resetCounters, IPAddress, SubnetMask } from '@/network/core/types';
import { WindowsPC } from '@/network/devices/WindowsPC';
import { WindowsServer } from '@/network/devices/WindowsServer';
import { GenericSwitch } from '@/network/devices/GenericSwitch';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
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

/** SRV1 (WindowsServer) and CLIENT1 (WindowsPC) on the same /24, via a switch. */
async function buildLan() {
  const srv = new WindowsServer('SRV1');
  const client = new WindowsPC('windows-pc', 'CLIENT1');
  const sw = new GenericSwitch('switch-generic', 'SW1');
  const cSrv = new Cable('c-srv');
  cSrv.connect(srv.getPorts()[0], sw.getPorts()[0]);
  const cClient = new Cable('c-client');
  cClient.connect(client.getPorts()[0], sw.getPorts()[1]);

  const mask = new SubnetMask('255.255.255.0');
  srv.getPorts()[0].configureIP(new IPAddress('192.168.10.10'), mask);
  client.getPorts()[0].configureIP(new IPAddress('192.168.10.20'), mask);
  client.addHostsEntry('192.168.10.10', 'SRV1');

  srv.setCurrentUser('Administrator');
  client.setCurrentUser('Administrator');
  // 'bob'/'alice' are seeded local accounts (password == username) —
  // see WindowsUserManager's default cast — no /add needed.

  await run(ps(srv), 'Install-WindowsFeature FS-FileServer');
  await srv.executeCommand('mkdir C:\\Shares\\Data');
  await srv.executeCommand('echo hello from srv1 > C:\\Shares\\Data\\doc.txt');
  await run(ps(srv), 'New-SmbShare -Name Data -Path C:\\Shares\\Data -FullAccess bob');

  return { srv, client, sw, cSrv, cClient };
}

describe('net use mounts a real SMB share across the network', () => {
  it('mounts, lists in Get-SmbSession on the server, and copy reads the remote file', async () => {
    const { srv, client } = await buildLan();

    const add = await client.executeCommand('net use Z: \\\\SRV1\\Data bob /user:SRV1\\bob');
    expect(add).toMatch(/command completed successfully/i);

    const sessions = await run(ps(srv), 'Get-SmbSession');
    expect(sessions).toContain('bob');
    expect(sessions).toMatch(/data/i);

    const copyOut = await client.executeCommand('copy Z:\\doc.txt C:\\');
    expect(copyOut).toMatch(/1 file\(s\) copied/i);
    expect((await client.executeCommand('type C:\\doc.txt')).trim()).toBe('hello from srv1');
  });

  it('dir Z:\\ lists the remote share contents over a mapped drive', async () => {
    const { client } = await buildLan();
    await client.executeCommand('net use Z: \\\\SRV1\\Data bob /user:SRV1\\bob');
    const out = await client.executeCommand('dir Z:\\');
    expect(out).toContain('doc.txt');
  });

  it('a user without share permission is refused with error 5', async () => {
    const { client } = await buildLan();
    const add = await client.executeCommand('net use Y: \\\\SRV1\\Data alice /user:SRV1\\alice');
    expect(add).toMatch(/system error 5/i);
    expect(add).toMatch(/access is denied/i);
    expect(await client.executeCommand('net use')).not.toContain('Y:');
  });

  it('a bad password is refused distinctly from a permission refusal', async () => {
    const { client } = await buildLan();
    const add = await client.executeCommand('net use Y: \\\\SRV1\\Data wrongpassword /user:SRV1\\bob');
    expect(add).toMatch(/system error 1326/i);
    expect(add).toMatch(/user name or password is incorrect/i);
  });

  it('net use Z: /delete disconnects the session from the server side too', async () => {
    const { srv, client } = await buildLan();
    await client.executeCommand('net use Z: \\\\SRV1\\Data bob /user:SRV1\\bob');
    expect(await run(ps(srv), 'Get-SmbSession')).toContain('bob');
    await client.executeCommand('net use Z: /delete');
    expect(await run(ps(srv), 'Get-SmbSession')).toBe('');
  });

  it('nothing works with the cable unplugged', async () => {
    const { client, cClient } = await buildLan();
    cClient.disconnect();
    const add = await client.executeCommand('net use Z: \\\\SRV1\\Data bob /user:SRV1\\bob');
    expect(add).toMatch(/network path was not found/i);
  });

  it('LanmanServer stopped on the server refuses the connection', async () => {
    const { srv, client } = await buildLan();
    await srv.executeCommand('net stop LanmanServer');
    const add = await client.executeCommand('net use Z: \\\\SRV1\\Data bob /user:SRV1\\bob');
    expect(add).toMatch(/system error (53|1225)/i);
  });
});

describe('net use across a router hop', () => {
  it('mounts a share on a server on a different subnet, through a router', async () => {
    const router = new CiscoRouter('R1');
    const swA = new GenericSwitch('switch-generic', 'SWA');
    const swB = new GenericSwitch('switch-generic', 'SWB');
    const srv = new WindowsServer('SRV2');
    const client = new WindowsPC('windows-pc', 'CLIENT2');

    new Cable('c-r0').connect(router.getPort('GigabitEthernet0/0')!, swA.getPorts()[0]);
    new Cable('c-srv').connect(srv.getPorts()[0], swA.getPorts()[1]);
    new Cable('c-r1').connect(router.getPort('GigabitEthernet0/1')!, swB.getPorts()[0]);
    new Cable('c-client').connect(client.getPorts()[0], swB.getPorts()[1]);

    router.configureInterface('GigabitEthernet0/0', new IPAddress('10.0.1.1'), new SubnetMask('255.255.255.0'));
    router.configureInterface('GigabitEthernet0/1', new IPAddress('10.0.2.1'), new SubnetMask('255.255.255.0'));
    for (const cmd of ['enable', 'configure terminal', 'interface GigabitEthernet0/0', 'no shutdown', 'exit', 'interface GigabitEthernet0/1', 'no shutdown', 'end']) {
      await router.executeCommand(cmd);
    }

    const mask = new SubnetMask('255.255.255.0');
    srv.getPorts()[0].configureIP(new IPAddress('10.0.1.10'), mask);
    srv.setDefaultGateway(new IPAddress('10.0.1.1'));
    client.getPorts()[0].configureIP(new IPAddress('10.0.2.10'), mask);
    client.setDefaultGateway(new IPAddress('10.0.2.1'));
    client.addHostsEntry('10.0.1.10', 'SRV2');

    srv.setCurrentUser('Administrator');
    await run(ps(srv), 'Install-WindowsFeature FS-FileServer');
    await srv.executeCommand('mkdir C:\\Shares\\Data');
    await run(ps(srv), 'New-SmbShare -Name Data -Path C:\\Shares\\Data -FullAccess bob');

    const add = await client.executeCommand('net use Z: \\\\SRV2\\Data bob /user:SRV2\\bob');
    expect(add).toMatch(/command completed successfully/i);
  });
});
