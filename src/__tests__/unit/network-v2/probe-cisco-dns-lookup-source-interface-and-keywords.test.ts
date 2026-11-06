/*
 * Reference: official_docs/cisco/ios-xe-catalyst-9600/ios-xe-17.15-catalyst-9600-command-reference.pdf, 'ip domain lookup [ nsap | recursive | source-interface
 * interface-type-number | vrf vrf-name { source-interface interface-type-number } ]'. The simulator accepted only 'source-interface' on the router, stored it and
 * rendered it, but no DNS query ever used it (rule 6: a criterion stored and never evaluated); the switch refused all four forms; and 'recursive', 'nsap' and
 * 'vrf ... source-interface' were refused everywhere. Now the source interface names the source ADDRESS of the DNS query on the wire (router: the port's address,
 * switch: the SVI or loopback address), the three other forms are accepted, stored and rendered back (the simulator has no CLNS and always sends RD=1, so 'recursive'
 * and 'nsap' change nothing observable: stated limit, recorded in TODO.md).
 *
 * Each case captures the frames DNS-RES receives and reads the source address of the query that carries the name.
 *
 * Measured against the commit before (worktree): 5 of the 6 cases fall (source address on the router, source address on the switch, the three keyword forms on the
 * switch/router); the 1 that passes either way is the WITNESS: without 'source-interface' the query leaves from the egress address on the wire (proves the lab and the tap).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { useNetworkStore } from '@/store/networkStore';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import { resetCounters, MACAddress } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { buildDnsAgenceBancaire } from '@/labs/dnsAgenceBancaire/build';

interface Shell { executeCommand(command: string): Promise<string>; getPorts?(): Array<{ attachTap(tap: (t: { direction: string; frame: { payload: unknown } }) => void): () => void }> }

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  MACAddress.resetCounter();
  EquipmentRegistry.resetInstance();
  Logger.reset();
  useNetworkStore.getState().clearAll();
});

const KNOWN = 'web.banquehorizon.com';

async function script(device: Shell, commands: readonly string[]): Promise<string> {
  let last = '';
  for (const command of commands) last = await device.executeCommand(command);
  return last;
}

function queriesSeenBy(server: Shell): string[] {
  const seen: string[] = [];
  for (const port of server.getPorts?.() ?? []) {
    port.attachTap((tapped) => {
      if (tapped.direction !== 'in') return;
      const packet = tapped.frame.payload as { sourceIP?: { toString(): string }; payload?: { destinationPort?: number } } | null;
      if (packet?.sourceIP !== undefined && packet.payload?.destinationPort === 53) seen.push(packet.sourceIP.toString());
    });
  }
  return seen;
}

async function lab() {
  await buildDnsAgenceBancaire();
  const find = (name: string) => [...useNetworkStore.getState().deviceInstances.values()].find((d) => d.getName() === name) as unknown as Shell;
  return { find, seen: queriesSeenBy(find('DNS-RES')) };
}

const ROUTER = ['enable', 'configure terminal', 'ip name-server 10.20.20.53'];

describe('ip domain lookup (Catalyst 9600 command reference)', () => {
  it('WITNESS the router query leaves from the egress address of the wire', async () => {
    const { find, seen } = await lab();
    await script(find('R-AGENCE'), [...ROUTER, 'end', `ping ${KNOWN}`]);
    expect(seen).toContain('10.20.20.1');
  });

  it('router: source-interface sets the source address of the query', async () => {
    const { find, seen } = await lab();
    await script(find('R-AGENCE'), [...ROUTER, 'ip domain lookup source-interface GigabitEthernet0/1.10', 'end', `ping ${KNOWN}`]);
    expect(seen).toContain('10.20.10.1');
    expect(seen).not.toContain('10.20.20.1');
  });

  it('switch: source-interface Vlan20 is accepted and sets the source address', async () => {
    const { find, seen } = await lab();
    const out = await script(find('SW-AGENCE'), ['enable', 'configure terminal', 'interface vlan 20', 'ip address 10.20.20.90 255.255.255.0', 'no shutdown', 'exit',
      'interface vlan 10', 'ip address 10.20.10.90 255.255.255.0', 'no shutdown', 'exit', 'ip default-gateway 10.20.20.1', 'ip name-server 10.20.20.53',
      'ip domain lookup source-interface vlan10', 'end', `ping ${KNOWN}`]);
    expect(out).toContain('Success rate');
    expect(seen).toContain('10.20.10.90');
  });

  it.each(['recursive', 'nsap', 'vrf BLUE source-interface GigabitEthernet0/0'])('router accepts and renders: ip domain lookup %s', async (form) => {
    const { find } = await lab();
    const router = find('R-AGENCE');
    const refusal = await script(router, ['enable', 'configure terminal', `ip domain lookup ${form}`]);
    expect(refusal).not.toContain('Invalid input');
    const shown = await script(router, ['end', 'show running-config | include domain-lookup']);
    expect(shown).toContain(form.split(' ')[0] === 'vrf' ? 'vrf BLUE' : form);
  });
});
