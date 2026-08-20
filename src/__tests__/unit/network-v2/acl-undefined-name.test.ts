/**
 * An undefined/empty ACL reference must permit, not deny (rapport 02 audit, item #41).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { IPAddress, SubnetMask, resetCounters } from '@/network/core/types';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { Cable } from '@/network/hardware/Cable';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  Logger.reset();
});

async function configureRouter(router: CiscoRouter, commands: string[]) {
  for (const cmd of commands) await router.executeCommand(cmd);
}

function buildTopology() {
  const pcA = new LinuxPC('linux-pc', 'PC_A');
  const r1 = new CiscoRouter('R1');
  const pcB = new LinuxPC('linux-pc', 'PC_B');

  r1.configureInterface('GigabitEthernet0/0', new IPAddress('10.0.1.1'), new SubnetMask('255.255.255.0'));
  r1.configureInterface('GigabitEthernet0/1', new IPAddress('10.0.2.1'), new SubnetMask('255.255.255.0'));
  pcA.configureInterface('eth0', new IPAddress('10.0.1.2'), new SubnetMask('255.255.255.0'));
  pcA.setDefaultGateway(new IPAddress('10.0.1.1'));
  pcB.configureInterface('eth0', new IPAddress('10.0.2.2'), new SubnetMask('255.255.255.0'));
  pcB.setDefaultGateway(new IPAddress('10.0.2.1'));

  new Cable('c1').connect(pcA.getPort('eth0')!, r1.getPort('GigabitEthernet0/0')!);
  new Cable('c2').connect(r1.getPort('GigabitEthernet0/1')!, pcB.getPort('eth0')!);

  return { pcA, pcB, r1 };
}

describe('ACL referencing an undefined name (rapport 02, item #41)', () => {
  it('ip access-group referencing a never-defined named ACL permits traffic', async () => {
    const { pcA, r1 } = buildTopology();
    await configureRouter(r1, [
      'enable', 'configure terminal',
      'interface GigabitEthernet0/0', 'ip access-group NEVER_DEFINED in', 'end',
    ]);
    const output = await pcA.executeCommand('ping -c 1 10.0.2.2');
    expect(output).toContain('64 bytes from 10.0.2.2');
  });

  it('ip access-group referencing a defined-but-empty named ACL permits traffic', async () => {
    const { pcA, r1 } = buildTopology();
    await configureRouter(r1, [
      'enable', 'configure terminal',
      'ip access-list extended EMPTY_ACL', 'exit',
      'interface GigabitEthernet0/0', 'ip access-group EMPTY_ACL in', 'end',
    ]);
    const output = await pcA.executeCommand('ping -c 1 10.0.2.2');
    expect(output).toContain('64 bytes from 10.0.2.2');
  });

  it('a defined ACL with entries still denies unmatched traffic (implicit deny unaffected)', async () => {
    const { pcA, r1 } = buildTopology();
    await configureRouter(r1, [
      'enable', 'configure terminal',
      'ip access-list standard ALLOW_OTHER', 'permit 192.168.0.0 0.0.255.255', 'exit',
      'interface GigabitEthernet0/0', 'ip access-group ALLOW_OTHER in', 'end',
    ]);
    const output = await pcA.executeCommand('ping -c 1 10.0.2.2');
    expect(output).not.toContain('64 bytes from 10.0.2.2');
  });

  it('NAT referencing an undefined ACL translates nothing', async () => {
    const r1 = new CiscoRouter('R1');
    const pcA = new LinuxPC('linux-pc', 'PC_A');
    const pcOut = new LinuxPC('linux-pc', 'PC_OUT');
    r1.configureInterface('GigabitEthernet0/0', new IPAddress('10.0.1.1'), new SubnetMask('255.255.255.0'));
    r1.configureInterface('GigabitEthernet0/1', new IPAddress('203.0.113.1'), new SubnetMask('255.255.255.0'));
    pcA.configureInterface('eth0', new IPAddress('10.0.1.2'), new SubnetMask('255.255.255.0'));
    pcA.setDefaultGateway(new IPAddress('10.0.1.1'));
    pcOut.configureInterface('eth0', new IPAddress('203.0.113.2'), new SubnetMask('255.255.255.0'));
    new Cable('c1').connect(pcA.getPort('eth0')!, r1.getPort('GigabitEthernet0/0')!);
    new Cable('c2').connect(r1.getPort('GigabitEthernet0/1')!, pcOut.getPort('eth0')!);
    await configureRouter(r1, [
      'enable', 'configure terminal',
      'interface GigabitEthernet0/0', 'ip nat inside', 'exit',
      'interface GigabitEthernet0/1', 'ip nat outside', 'exit',
      'ip nat inside source list NEVER_DEFINED interface GigabitEthernet0/1 overload',
    ]);
    await pcA.executeCommand('ping -c 1 203.0.113.2');
    const table = await r1.executeCommand('show ip nat translations');
    expect(table).not.toContain('10.0.1.2');
  });
});
