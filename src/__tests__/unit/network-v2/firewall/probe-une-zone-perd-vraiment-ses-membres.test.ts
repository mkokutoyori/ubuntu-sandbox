/**
 * Retirer une interface d'une zone ne la retirait pas.
 *
 * Pentest du pare-feu. Une politique `srcintf INSIDE` ; la zone INSIDE
 * contient `port1 port3` ; on la reduit a `set interface port3`. La CLI
 * remplace bien la liste — `show system zone` rend `set interface
 * "port3"` — et pourtant le trafic de `port1` continuait d'etre accepte,
 * meme table de sessions videe.
 *
 * La cause est un DOUBLON (§2), et c'est le plus permissif des deux qui
 * servait (§1, troisieme piege). Deux ecritures de « l'appartenance de
 * cette zone est exactement cet ensemble » :
 *
 *   commitDevice.applyZone      ajoutait les membres, n'en retirait aucun
 *   Firewall.publishSdwanZones  retirait les absents, puis ajoutait
 *
 * La seconde etait juste mais reservee aux zones SD-WAN. L'operation vit
 * desormais une seule fois, sur la table qui possede l'appartenance
 * (`ZoneTable.setInterfaces`), et les deux appelants y passent.
 *
 * Discrimination (`git stash push -- src/network/devices/firewall/`) :
 * DEUX cas sur cinq tombent avant correctif — le trafic d'une interface
 * retiree, avec et sans session. Les trois qui passent des deux cotes
 * sont nommes :
 *
 *   - « a zone member is admitted » : le TEMOIN, sans lequel deux refus
 *     ne prouveraient qu'une maquette muette ;
 *   - « a zone built without the interface refuses it » : la resolution
 *     zone -> interfaces etait deja juste quand la zone naissait sans
 *     l'interface ; c'est la MODIFICATION qui ne retirait rien ;
 *   - « the zone renders only its remaining member » : la CLI et le
 *     `show` etaient deja justes — c'est la table du moteur qui mentait,
 *     et le dire evite d'aller chercher dans le parseur.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { FortiGate } from '@/network/devices/firewall/vendors/fortios/FortiGate';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { Cable } from '@/network/hardware/Cable';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';

const reached = (output: string): boolean => /, 0% packet loss/.test(output);

interface Lab { fw: FortiGate; lan: LinuxPC }

async function lab(zoneMembers: string): Promise<Lab> {
  EquipmentRegistry.resetInstance();
  const fw = new FortiGate('firewall-fortinet', 'FW1', 0, 0);
  const lan = new LinuxPC('linux-pc', 'LAN', 0, 0);
  const dmz = new LinuxPC('linux-pc', 'DMZ', 0, 0);
  [fw, lan, dmz].forEach(d => d.powerOn());
  const port = (name: string) => fw.getPorts().find(p => p.getName() === name)!;
  new Cable('lan').connect(port('port1'), lan.getPort('eth0')!);
  new Cable('dmz').connect(port('port2'), dmz.getPort('eth0')!);
  await lan.executeCommand('ifconfig eth0 192.168.1.2');
  await lan.executeCommand('ip route add default via 192.168.1.99');
  await dmz.executeCommand('ifconfig eth0 192.168.20.2');
  await dmz.executeCommand('ip route add default via 192.168.20.1');
  for (const line of [
    'config system interface',
    'edit port1', 'set ip 192.168.1.99 255.255.255.0', 'next',
    'edit port2', 'set ip 192.168.20.1 255.255.255.0', 'next',
    'end',
    'config system zone', 'edit INSIDE', `set interface ${zoneMembers}`, 'next', 'end',
    'config firewall policy', 'edit 1', 'set srcintf INSIDE', 'set dstintf port2',
    'set srcaddr all', 'set dstaddr all', 'set service ALL', 'set action accept',
    'next', 'end',
  ]) await fw.executeCommand(line);
  return { fw, lan };
}

async function shrinkZoneToPort3(fw: FortiGate): Promise<void> {
  for (const line of ['config system zone', 'edit INSIDE', 'set interface port3', 'next', 'end']) {
    await fw.executeCommand(line);
  }
}

describe('une zone perd vraiment ses membres', () => {
  let it0: Lab;
  beforeEach(async () => { it0 = await lab('port1 port3'); });

  it('a zone member is admitted', async () => {
    expect(reached(await it0.lan.executeCommand('ping -c 2 192.168.20.2'))).toBe(true);
  }, 60_000);

  it('an interface removed from the zone is refused', async () => {
    await shrinkZoneToPort3(it0.fw);

    expect(reached(await it0.lan.executeCommand('ping -c 2 192.168.20.2'))).toBe(false);
  }, 60_000);

  it('an interface removed from the zone cannot ride a session opened before', async () => {
    expect(reached(await it0.lan.executeCommand('ping -c 2 192.168.20.2'))).toBe(true);
    await shrinkZoneToPort3(it0.fw);

    expect(reached(await it0.lan.executeCommand('ping -c 2 192.168.20.2'))).toBe(false);
  }, 60_000);

  it('a zone built without the interface refuses it', async () => {
    const fresh = await lab('port3');

    expect(reached(await fresh.lan.executeCommand('ping -c 2 192.168.20.2'))).toBe(false);
  }, 60_000);

  it('the zone renders only its remaining member', async () => {
    await shrinkZoneToPort3(it0.fw);

    const shown = await it0.fw.executeCommand('show system zone');
    expect(shown).toContain('set interface "port3"');
    expect(shown).not.toContain('"port1"');
  }, 60_000);
});
