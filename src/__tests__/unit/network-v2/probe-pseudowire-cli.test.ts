/**
 * Probe: the IOS commands that build a pseudowire (xconnect) and a targeted LDP session.
 * Same lab as probe-pseudowire-rfc4447-4448 but configured only through the CLI.
 * New: all 4 cases fail before (xconnect and the targeted commands are refused).
 * Witness: the same lab before the commands carries no frame between the CEs.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { Cable } from '@/network/hardware/Cable';
import { IPAddress } from '@/network/core/types';
import { VirtualTimeScheduler, __setDefaultScheduler } from '@/events/Scheduler';
import { MplsLabel } from '@/network/mpls/MplsLabel';
import { LdpIdentifier } from '@/network/ldp/LdpIdentifier';
import { decodePdu, encodePdu } from '@/network/ldp/LdpCodec';
import { StatusCode, type PwIdFec } from '@/network/ldp/LdpMessages';

let clock: VirtualTimeScheduler;
beforeEach(() => { clock = new VirtualTimeScheduler(); __setDefaultScheduler(clock); });

async function run(router: CiscoRouter, lines: string[]): Promise<void> {
  for (const line of ['enable', 'configure terminal', ...lines, 'end']) await router.executeCommand(line);
}

async function whileTimePasses<T>(work: Promise<T>): Promise<T> {
  let done = false;
  void work.finally(() => { done = true; });
  while (!done) {
    clock.advance(100);
    await new Promise<void>(resolve => setImmediate(resolve));
  }
  return work;
}


async function cliLab() {
  const ce1 = new LinuxPC('linux-pc', 'CE1');
  const ce2 = new LinuxPC('linux-pc', 'CE2');
  const pe1 = new CiscoRouter('PE1');
  const p = new CiscoRouter('P');
  const pe2 = new CiscoRouter('PE2');
  new Cable('a').connect(ce1.getPort('eth0')!, pe1.getPort('GigabitEthernet0/0')!);
  new Cable('b').connect(pe1.getPort('GigabitEthernet0/1')!, p.getPort('GigabitEthernet0/0')!);
  new Cable('c').connect(p.getPort('GigabitEthernet0/1')!, pe2.getPort('GigabitEthernet0/0')!);
  new Cable('d').connect(pe2.getPort('GigabitEthernet0/1')!, ce2.getPort('eth0')!);
  await run(pe1, ['interface Loopback0', 'ip address 1.1.1.1 255.255.255.255', 'exit',
    'interface GigabitEthernet0/0', 'no shutdown', 'exit',
    'interface GigabitEthernet0/1', 'ip address 10.12.0.1 255.255.255.0', 'mpls ip', 'no shutdown', 'exit',
    'ip route 2.2.2.2 255.255.255.255 10.12.0.2', 'ip route 3.3.3.3 255.255.255.255 10.12.0.2', 'ip route 10.23.0.0 255.255.255.0 10.12.0.2']);
  await run(p, ['interface Loopback0', 'ip address 2.2.2.2 255.255.255.255', 'exit',
    'interface GigabitEthernet0/0', 'ip address 10.12.0.2 255.255.255.0', 'mpls ip', 'no shutdown', 'exit',
    'interface GigabitEthernet0/1', 'ip address 10.23.0.2 255.255.255.0', 'mpls ip', 'no shutdown', 'exit',
    'ip route 1.1.1.1 255.255.255.255 10.12.0.1', 'ip route 3.3.3.3 255.255.255.255 10.23.0.3']);
  await run(pe2, ['interface Loopback0', 'ip address 3.3.3.3 255.255.255.255', 'exit',
    'interface GigabitEthernet0/0', 'ip address 10.23.0.3 255.255.255.0', 'mpls ip', 'no shutdown', 'exit',
    'interface GigabitEthernet0/1', 'no shutdown', 'exit',
    'ip route 1.1.1.1 255.255.255.255 10.23.0.2', 'ip route 2.2.2.2 255.255.255.255 10.23.0.2', 'ip route 10.12.0.0 255.255.255.0 10.23.0.2']);
  await ce1.executeCommand('sudo ip addr add 192.168.0.1/24 dev eth0');
  await ce2.executeCommand('sudo ip addr add 192.168.0.2/24 dev eth0');
  clock.advance(6000);
  return { ce1, ce2, pe1, pe2 };
}

describe('xconnect and targeted LDP from the CLI', () => {
  it('WITNESS: before the commands the CEs are not connected', async () => {
    const { ce1 } = await cliLab();
    const out = await whileTimePasses(ce1.executeCommand('ping -c 2 -W 1 192.168.0.2'));
    expect(out).toContain('0 received');
  });

  it('xconnect on both PEs builds the pseudowire and the CEs ping each other', async () => {
    const { ce1, pe1, pe2 } = await cliLab();
    await run(pe1, ['interface GigabitEthernet0/0', 'xconnect 3.3.3.3 100 encapsulation mpls']);
    await run(pe2, ['interface GigabitEthernet0/1', 'xconnect 1.1.1.1 100 encapsulation mpls']);
    clock.advance(60000);
    expect(pe1.getPseudowireEngine().views()[0].state).toBe('up');
    const out = await whileTimePasses(ce1.executeCommand('ping -c 2 -W 1 192.168.0.2'));
    expect(out).toContain('2 received');
  });

  it('the running configuration shows the xconnect and the targeted neighbour, and no xconnect removes it', async () => {
    const { pe1 } = await cliLab();
    await run(pe1, ['mpls ldp discovery targeted-hello accept', 'mpls ldp neighbor 3.3.3.3 targeted ldp',
      'interface GigabitEthernet0/0', 'xconnect 3.3.3.3 100 encapsulation mpls']);
    const config = await pe1.executeCommand('show running-config');
    expect(config).toContain(' xconnect 3.3.3.3 100 encapsulation mpls');
    expect(config).toContain('mpls ldp neighbor 3.3.3.3 targeted ldp');
    expect(config).toContain('mpls ldp discovery targeted-hello accept');
    await run(pe1, ['interface GigabitEthernet0/0', 'no xconnect']);
    expect(await pe1.executeCommand('show running-config')).not.toContain('xconnect');
  });

  it('a malformed xconnect is refused by the parser', async () => {
    const { pe1 } = await cliLab();
    for (const line of ['enable', 'configure terminal', 'interface GigabitEthernet0/0']) await pe1.executeCommand(line);
    const out = await pe1.executeCommand('xconnect zorglub 100 encapsulation mpls');
    expect(out).toMatch(/Invalid|Incomplete/);
  });
});
