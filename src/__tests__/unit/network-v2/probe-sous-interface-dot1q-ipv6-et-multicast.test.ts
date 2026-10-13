/**
 * Mesure de depart (suite du lab « Akwa », meme famille que probe-ospf-sur-sous-interface-dot1q) :
 * une sous-interface dot1Q n'a pas de porteuse propre, elle emprunte celle du port physique
 * parent (`carrierBearer`). Deux chemins de `Router` la jugeaient encore sur son propre port :
 * `IPv6DataPlane.resolvePath` (tout paquet IPv6 emis par le routeur, sondes d'echo comprises, et
 * les reponses aux sollicitations de voisin) et `sendOnNamedInterface` (tout paquet multicast ou
 * de diffusion emis sur une interface nommee : HSRP, VRRP, GLBP, IGMP, PIM...). Resultat mesure :
 * `ping ipv6` 0/5 dans les DEUX sens entre un routeur a sous-interface et son voisin, et
 * `sendIpv4Packet` vers 224.0.0.102 refuse sur la sous-interface alors qu'il part sur le port
 * physique du voisin. Les deux lisent maintenant `iosInterfaceUsable`, comme `show interfaces`.
 *
 * Laboratoire : R1 (Gi0/1 en acces VLAN 99 sur un commutateur) et R2 (Gi0/0 en trunk, adresse sur
 * Gi0/0.99). Sur les cinq cas, trois tombent avant la correction (les deux sens du ping IPv6 et
 * l'emission multicast depuis la sous-interface). Les deux temoins passent dans les deux etats :
 * le meme lab sans sous-interface (adresse sur le port physique, acces VLAN 99) repond 5/5, et le
 * port physique de R1 emet bien le multicast ; ils prouvent que le cablage et le commutateur sont
 * sains.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { CiscoSwitch } from '@/network/devices/CiscoSwitch';
import { Cable } from '@/network/hardware/Cable';
import { IPAddress, resetCounters, MACAddress } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';

interface Cmd { executeCommand(cmd: string): Promise<string> }
const run = async (d: Cmd, cmds: string[]) => { for (const c of cmds) await d.executeCommand(c); };

async function lab(subinterface: boolean): Promise<{ r1: CiscoRouter; r2: CiscoRouter }> {
  const r1 = new CiscoRouter('R1', 0, 0);
  const r2 = new CiscoRouter('R2', 0, 0);
  const sw = new CiscoSwitch('switch-cisco', 'SW', 26, 0, 0);
  new Cable('a').connect(r1.getPort('GigabitEthernet0/1')!, sw.getPort('FastEthernet0/1')!);
  new Cable('b').connect(r2.getPort('GigabitEthernet0/0')!, sw.getPort('FastEthernet0/2')!);
  await run(sw, ['enable', 'configure terminal', 'vlan 99', 'exit',
    'interface FastEthernet0/1', 'switchport mode access', 'switchport access vlan 99', 'exit',
    'interface FastEthernet0/2',
    ...(subinterface
      ? ['switchport trunk encapsulation dot1q', 'switchport mode trunk', 'switchport trunk allowed vlan 99']
      : ['switchport mode access', 'switchport access vlan 99']),
    'end']);
  await run(r1, ['enable', 'configure terminal', 'ipv6 unicast-routing',
    'interface GigabitEthernet0/1', 'ipv6 address 2001:db8:20::1/64', 'ip address 10.0.20.1 255.255.255.0',
    'no shutdown', 'end']);
  await run(r2, ['enable', 'configure terminal', 'ipv6 unicast-routing',
    ...(subinterface
      ? ['interface GigabitEthernet0/0', 'no shutdown', 'exit',
        'interface GigabitEthernet0/0.99', 'encapsulation dot1Q 99',
        'ipv6 address 2001:db8:20::2/64', 'ip address 10.0.20.2 255.255.255.0']
      : ['interface GigabitEthernet0/0', 'ipv6 address 2001:db8:20::2/64',
        'ip address 10.0.20.2 255.255.255.0', 'no shutdown']),
    'end']);
  return { r1, r2 };
}

const hsrpGroup = (iface: string) => ({
  destination: new IPAddress('224.0.0.102'), protocol: 112, payload: {}, payloadBytes: 20, iface,
});

beforeEach(() => {
  resetCounters(); resetDeviceCounters(); MACAddress.resetCounter(); Logger.reset();
});

describe('router-on-a-stick subinterface: IPv6 and multicast egress', () => {
  it('witness: without a subinterface the IPv6 ping answers 5/5 in both directions', async () => {
    const { r1, r2 } = await lab(false);
    expect(await r1.executeCommand('ping ipv6 2001:db8:20::2')).toContain('Success rate is 100 percent');
    expect(await r2.executeCommand('ping ipv6 2001:db8:20::1')).toContain('Success rate is 100 percent');
  });

  it('witness: the physical port of R1 sends the multicast', async () => {
    const { r1 } = await lab(true);
    expect(r1.sendIpv4Packet(hsrpGroup('GigabitEthernet0/1'))).toBe(true);
  });

  it('R1 pings R2 over IPv6 when R2 answers from its subinterface', async () => {
    const { r1 } = await lab(true);
    expect(await r1.executeCommand('ping ipv6 2001:db8:20::2')).toContain('Success rate is 100 percent');
  });

  it('R2 pings R1 over IPv6 from its own subinterface', async () => {
    const { r2 } = await lab(true);
    expect(await r2.executeCommand('ping ipv6 2001:db8:20::1')).toContain('Success rate is 100 percent');
  });

  it('R2 sends a multicast control packet out of its subinterface', async () => {
    const { r2 } = await lab(true);
    expect(r2.sendIpv4Packet(hsrpGroup('GigabitEthernet0/0.99'))).toBe(true);
  });
});
