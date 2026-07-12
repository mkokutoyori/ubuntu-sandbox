/**
 * ms-DS-MachineAccountQuota (MS-ADTS §3.1.1.5.2.5, default 10) — how
 * many computer accounts an ordinary domain user may create via domain
 * join before being refused. Previously absent entirely: any
 * authenticated user could join unlimited computers. Enforced at the
 * single real choke point for computer-account creation via LDAP
 * (`LdapServerHandler`'s `addRequest` handling) — Domain Admins are
 * exempt, matching real AD's own semantics.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { resetCounters, IPAddress, SubnetMask } from '@/network/core/types';
import { WindowsServer } from '@/network/devices/WindowsServer';
import { WindowsPC } from '@/network/devices/WindowsPC';
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

const ps = (d: WindowsServer) => PowerShellSubShell.create(d).subShell;
const run = async (sh: ReturnType<typeof ps>, l: string) => (await sh.processLine(l)).output.join('\n');

async function buildLab(): Promise<{ dc: WindowsServer; sw: GenericSwitch }> {
  const dc = new WindowsServer('DC1');
  const sw = new GenericSwitch('switch-generic', 'SW1');
  new Cable('c-dc').connect(dc.getPorts()[0], sw.getPorts()[0]);
  dc.getPorts()[0].configureIP(new IPAddress('192.168.84.10'), new SubnetMask('255.255.255.0'));
  dc.setCurrentUser('Administrator');
  await run(ps(dc), 'Install-WindowsFeature AD-Domain-Services');
  dc.installADDSForest('lab.local', 'LAB', 'P@ssw0rd');
  dc.getDirectoryStore()!.newUser('alice', { password: 'alicepw' });
  return { dc, sw };
}

let nextSwitchPort = 1;
let nextIp = 20;
function newClient(sw: GenericSwitch, name: string): WindowsPC {
  const client = new WindowsPC('windows-pc', name);
  new Cable(`c-${name}`).connect(client.getPorts()[0], sw.getPorts()[nextSwitchPort++]);
  client.getPorts()[0].configureIP(new IPAddress(`192.168.84.${nextIp++}`), new SubnetMask('255.255.255.0'));
  return client;
}

describe('DirectoryStore — ms-DS-MachineAccountQuota', () => {
  it('defaults to 10 and is configurable', async () => {
    const { dc } = await buildLab();
    expect(dc.getDirectoryStore()!.getMachineAccountQuota()).toBe(10);
    dc.getDirectoryStore()!.setMachineAccountQuota(3);
    expect(dc.getDirectoryStore()!.getMachineAccountQuota()).toBe(3);
  });

  it('refuses a join once an ordinary user has exhausted their quota, but exempts Domain Admins', async () => {
    const { dc, sw } = await buildLab();
    dc.getDirectoryStore()!.setMachineAccountQuota(2);

    const c1 = newClient(sw, 'CLIENT1');
    const c2 = newClient(sw, 'CLIENT2');
    const c3 = newClient(sw, 'CLIENT3');
    const c4 = newClient(sw, 'CLIENT4');

    const r1 = c1.joinDomainNow('lab.local', '192.168.84.10', 'alice', 'alicepw');
    const r2 = c2.joinDomainNow('lab.local', '192.168.84.10', 'alice', 'alicepw');
    expect(r1.ok).toBe(true);
    expect(r2.ok).toBe(true);

    const r3 = c3.joinDomainNow('lab.local', '192.168.84.10', 'alice', 'alicepw');
    expect(r3.ok).toBe(false);

    const r4 = c4.joinDomainNow('lab.local', '192.168.84.10', 'Administrator', 'P@ssw0rd');
    expect(r4.ok).toBe(true);
  });
});
