/*
 * `neighbor <ip> shutdown` sous `router bgp` etait un critere stocke et
 * jamais evalue : la ligne partait dans la liste des attributs rendus par
 * `show running-config` et le moteur BGP ne la voyait jamais. Mesure de
 * depart sur deux routeurs pairs en eBGP etablis : apres `neighbor
 * 10.0.9.2 shutdown` la session restait Established et le pair gardait la
 * route annoncee.
 *
 * Le moteur porte maintenant un drapeau `shutdown` par voisin : la session
 * est fermee par un NOTIFICATION Cease / Administrative Shutdown (RFC 4271
 * §6.7, sous-code 2 de la RFC 4486), le voisin n'est plus rappele ni
 * accepte en entrant, et `show ip bgp summary` rend `Idle (Admin)`.
 * `no neighbor <ip> shutdown` leve le drapeau et la session remonte.
 *
 * Avant le correctif : 3 des 4 cas tombent (git stash de src/network).
 * Passe des deux cotes le TEMOIN « les deux routeurs s'etablissent et le
 * pair apprend la route » : sans lui, un laboratoire qui n'etablirait
 * jamais satisferait les cas de retrait.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { Cable } from '@/network/hardware/Cable';
import { MACAddress, resetCounters } from '@/network/core/types';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  MACAddress.resetCounter();
  EquipmentRegistry.resetInstance();
  Logger.clear();
});

async function run(d: CiscoRouter, ...lines: string[]): Promise<string> {
  let last = '';
  for (const l of lines) last = await d.executeCommand(l);
  return last;
}

async function pair() {
  const p = new CiscoRouter('BA1');
  const q = new CiscoRouter('BB1');
  new Cable('bc1').connect(p.getPorts()[0], q.getPorts()[0]);
  for (const [d, ip] of [[p, '10.0.9.1'], [q, '10.0.9.2']] as const) {
    await run(d, 'enable', 'configure terminal', 'interface GigabitEthernet0/0',
      `ip address ${ip} 255.255.255.0`, 'no shutdown', 'end');
  }
  await run(q, 'configure terminal', 'interface Loopback0', 'ip address 192.0.2.1 255.255.255.255', 'exit',
    'router bgp 65002', 'neighbor 10.0.9.1 remote-as 65001', 'network 192.0.2.1 mask 255.255.255.255', 'end');
  await run(p, 'configure terminal', 'router bgp 65001', 'neighbor 10.0.9.2 remote-as 65002', 'end');
  return { p, q };
}

describe('neighbor shutdown', () => {
  it('WITNESS : les deux routeurs s etablissent et le pair apprend la route', async () => {
    const { p } = await pair();
    expect(await run(p, 'show ip bgp')).toContain('192.0.2.1/32');
    expect(await run(p, 'show ip bgp summary')).not.toContain('Idle');
  });

  it('shutdown ferme la session et retire la route apprise', async () => {
    const { p } = await pair();
    await run(p, 'configure terminal', 'router bgp 65001', 'neighbor 10.0.9.2 shutdown', 'end');
    expect(await run(p, 'show ip bgp')).not.toContain('192.0.2.1/32');
  });

  it('show ip bgp summary rend Idle (Admin) et le voisin ne remonte pas', async () => {
    const { p, q } = await pair();
    await run(p, 'configure terminal', 'router bgp 65001', 'neighbor 10.0.9.2 shutdown', 'end');
    expect(await run(p, 'show ip bgp summary')).toContain('Idle (Admin)');
    await run(q, 'show ip bgp summary');
    expect(await run(p, 'show ip bgp')).not.toContain('192.0.2.1/32');
  });

  it('no neighbor shutdown rouvre la session', async () => {
    const { p } = await pair();
    await run(p, 'configure terminal', 'router bgp 65001', 'neighbor 10.0.9.2 shutdown', 'end');
    await run(p, 'configure terminal', 'router bgp 65001', 'no neighbor 10.0.9.2 shutdown', 'end');
    expect(await run(p, 'show ip bgp summary')).not.toContain('Idle (Admin)');
    expect(await run(p, 'show ip bgp')).toContain('192.0.2.1/32');
    expect(await run(p, 'show running-config')).not.toContain('neighbor 10.0.9.2 shutdown');
  });
});
