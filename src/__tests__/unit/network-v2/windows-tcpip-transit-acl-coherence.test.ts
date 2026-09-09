/**
 * Windows TCP/IP client coherence through a filtering router: a Windows host
 * shares the same TcpStack as a Linux host, so its probes must SUFFER a
 * transit ACL on the wire too — never report success through a deny router.
 *
 * Measured (Rule 7). A `deny ip any any` router answers ICMP administratively-
 * prohibited; tcpProbeSync then never reaches 'established', so
 * Test-NetConnection reports TcpTestSucceeded: False and Invoke-WebRequest
 * fails to connect. WITNESSES (no ACL) prove the lab reaches the service.
 * ping (cmd) already renders the filter directly.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { WindowsPC } from '@/network/devices/WindowsPC';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { PowerShellSubShell } from '@/terminal/subshells/PowerShellSubShell';
import { Cable } from '@/network/hardware/Cable';
import { IPAddress, SubnetMask, resetCounters } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  Logger.reset();
});

const ps = (d: WindowsPC) => PowerShellSubShell.create(d).subShell;
const run = async (sh: ReturnType<typeof ps>, l: string) => (await sh.processLine(l)).output.join('\n');

async function lab(acl: readonly string[]) {
  const router = new CiscoRouter('R1');
  const win = new WindowsPC('windows-pc', 'WIN1');
  const srv = new LinuxServer('linux-server', 'SRV1');
  new Cable('c1').connect(router.getPort('GigabitEthernet0/0')!, win.getPorts()[0]);
  new Cable('c2').connect(router.getPort('GigabitEthernet0/1')!, srv.getPort('eth0')!);
  for (const line of ['enable', 'configure terminal',
    'interface GigabitEthernet0/0', 'ip address 10.0.1.1 255.255.255.0', 'no shutdown', 'exit',
    'interface GigabitEthernet0/1', 'ip address 10.0.2.1 255.255.255.0', 'no shutdown', 'exit',
    ...acl,
    ...(acl.length ? ['interface GigabitEthernet0/0', 'ip access-group 100 in', 'exit'] : []),
    'end']) {
    await router.executeCommand(line);
  }
  win.getPorts()[0].configureIP(new IPAddress('10.0.1.10'), new SubnetMask('255.255.255.0'));
  win.setDefaultGateway(new IPAddress('10.0.1.1'));
  srv.configureInterface('eth0', new IPAddress('10.0.2.10'), new SubnetMask('255.255.255.0'));
  srv.setDefaultGateway(new IPAddress('10.0.2.1'));
  win.setCurrentUser('Administrator');
  await win.executeCommand('ping -n 1 10.0.2.10');
  await srv.executeCommand('sudo systemctl start ssh');
  await srv.executeCommand('sudo systemctl start nginx');
  return { win, srv };
}

const DENY = ['access-list 100 deny ip any any'];

describe('Windows TCP/IP client commands suffer the transit ACL', () => {
  it('Test-NetConnection: witness True, deny False', async () => {
    const { win: open } = await lab([]);
    expect(await run(ps(open), 'Test-NetConnection 10.0.2.10 -Port 22')).toMatch(/TcpTestSucceeded\s*:\s*True/i);
    const { win: blocked } = await lab(DENY);
    expect(await run(ps(blocked), 'Test-NetConnection 10.0.2.10 -Port 22')).toMatch(/TcpTestSucceeded\s*:\s*False/i);
  });

  it('Invoke-WebRequest: witness gets a page, deny cannot connect', async () => {
    const { win: open } = await lab([]);
    expect(await run(ps(open), '(Invoke-WebRequest http://10.0.2.10/).StatusCode')).toMatch(/200/);
    const { win: blocked } = await lab(DENY);
    expect(await run(ps(blocked), '(Invoke-WebRequest http://10.0.2.10/).StatusCode')).not.toMatch(/200/);
  });

  it('ping (cmd): witness replies, deny is filtered', async () => {
    const { win: open } = await lab([]);
    expect(await open.executeCommand('ping -n 1 10.0.2.10')).toMatch(/Reply from 10\.0\.2\.10/i);
    const { win: blocked } = await lab(DENY);
    expect(await blocked.executeCommand('ping -n 1 10.0.2.10')).not.toMatch(/Reply from 10\.0\.2\.10/i);
  });
});
