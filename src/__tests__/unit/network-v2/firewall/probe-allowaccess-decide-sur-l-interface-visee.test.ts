/**
 * `allowaccess` etait evalue sur l'interface d'ENTREE pour le ping.
 *
 * Signalement a l'usage : « allowaccess ping ssh sur une interface, puis
 * on n'autorise plus que ssh, et le ping continue de passer ». Reproduit :
 * un paquet ICMP entre par port1 et vise l'adresse de port2 ; la garde
 * lisait la liste de port1. `admitsTcp` avait deja ete corrige pour juger
 * sur l'interface qui PORTE l'adresse visee ; `allowsPing` etait reste sur
 * l'ingress. Deux vues d'un meme reglage, divergentes (§3).
 *
 * Deux autres defauts fermes dans le meme geste :
 *   - la garde `allowsPing` etait posee sur TOUT ce qui n'est pas TCP,
 *     donc elle jugeait l'UDP au nom du ping. Elle ne decide plus que
 *     l'ICMP, ce qui est ce que `allowaccess ping` veut dire ;
 *   - le plan IPv6 portait la meme erreur d'interface, alignee sur la
 *     meme regle.
 *
 * Discrimination (`git stash push -- src/network/devices/firewall/`) :
 * UN cas sur sept tombe avant correctif — « narrowing port2 to ssh
 * closes ping on port2 », exactement le signalement. Les SIX qui passent
 * des deux cotes sont nommes plutot que laisses a deviner : un refus
 * isole ne prouverait qu'une maquette muette.
 *
 *   - « port1 answers ping » et « port2 answers ping » : les TEMOINS. Ils
 *     prouvent que la maquette sait repondre, donc que le refus du
 *     troisieme cas est un refus et non un silence ;
 *   - « narrowing port2 leaves port1 alone » : le correctif vise UNE
 *     interface, pas toutes ;
 *   - « unset allowaccess closes ping » : non-regression, une liste vide
 *     refusait deja ;
 *   - « ssh is admitted on the interface that allows it » : l'autre
 *     moitie du reglage, qui doit s'ouvrir quand le ping se ferme ;
 *   - « the rendered config says what the data plane enforces » : le
 *     `show` etait deja juste — c'est l'EVALUATION qui mentait, et le
 *     dire ici evite de croire que la CLI etait en cause.
 *
 * Les deux autres defauts fermes (la garde qui jugeait l'UDP au nom du
 * ping, et l'IPv6) n'ont pas de cas ici : le premier n'a pas de service
 * UDP a interroger sur ce pare-feu, le second pas de maquette IPv6. Ils
 * sont corriges par lecture du meme invariant, et c'est dit plutot que
 * laisse croire a une couverture qui n'existe pas.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { FortiGate } from '@/network/devices/firewall/vendors/fortios/FortiGate';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { Cable } from '@/network/hardware/Cable';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';

const PORT1 = '192.168.1.99';
const PORT2 = '192.168.20.2';
const CLIENT = '192.168.1.2';

const reached = (output: string): boolean => /, 0% packet loss/.test(output);

interface Lab { fw: FortiGate; pc: LinuxPC }

async function lab(): Promise<Lab> {
  EquipmentRegistry.resetInstance();
  const fw = new FortiGate('firewall-fortinet', 'FW1', 0, 0);
  const pc = new LinuxPC('linux-pc', 'PC', 0, 0);
  fw.powerOn();
  pc.powerOn();
  new Cable('lan').connect(fw.getPorts()[0], pc.getPort('eth0')!);
  await pc.executeCommand(`ifconfig eth0 ${CLIENT}`);
  await pc.executeCommand(`ip route add default via ${PORT1}`);
  for (const line of [
    'config system interface',
    'edit port1', `set ip ${PORT1} 255.255.255.0`, 'set allowaccess ping ssh', 'next',
    'edit port2', `set ip ${PORT2} 255.255.255.252`, 'set allowaccess ping', 'next',
    'end',
  ]) await fw.executeCommand(line);
  return { fw, pc };
}

async function setAllowAccess(fw: FortiGate, iface: string, value: string): Promise<void> {
  for (const line of [
    'config system interface', `edit ${iface}`, value, 'next', 'end',
  ]) await fw.executeCommand(line);
}

describe('allowaccess decide sur l interface visee', () => {
  let it0: Lab;
  beforeEach(async () => { it0 = await lab(); });

  it('port1 answers ping while its own list allows it', async () => {
    expect(reached(await it0.pc.executeCommand(`ping -c 2 ${PORT1}`))).toBe(true);
  }, 60_000);

  it('port2 answers ping while its own list allows it', async () => {
    expect(reached(await it0.pc.executeCommand(`ping -c 2 ${PORT2}`))).toBe(true);
  }, 60_000);

  it('narrowing port2 to ssh closes ping on port2', async () => {
    await setAllowAccess(it0.fw, 'port2', 'set allowaccess ssh');

    expect(reached(await it0.pc.executeCommand(`ping -c 2 ${PORT2}`))).toBe(false);
  }, 60_000);

  it('narrowing port2 leaves port1 alone', async () => {
    await setAllowAccess(it0.fw, 'port2', 'set allowaccess ssh');

    expect(reached(await it0.pc.executeCommand(`ping -c 2 ${PORT1}`))).toBe(true);
  }, 60_000);

  it('unset allowaccess closes ping on that interface', async () => {
    await setAllowAccess(it0.fw, 'port1', 'unset allowaccess');

    expect(reached(await it0.pc.executeCommand(`ping -c 2 ${PORT1}`))).toBe(false);
  }, 60_000);

  it('ssh is admitted on the interface that allows it', async () => {
    await setAllowAccess(it0.fw, 'port2', 'set allowaccess ssh');

    expect(it0.fw.allowsAccess('port2', 'ssh')).toBe(true);
    expect(it0.fw.allowsAccess('port2', 'ping')).toBe(false);
  }, 60_000);

  it('the rendered config says what the data plane enforces', async () => {
    await setAllowAccess(it0.fw, 'port2', 'set allowaccess ssh');

    const shown = await it0.fw.executeCommand('show system interface');
    const port2Block = shown.slice(shown.indexOf('edit "port2"'));
    expect(port2Block).toContain('set allowaccess ssh');
    expect(port2Block.slice(0, port2Block.indexOf('next'))).not.toMatch(/allowaccess.*\bping\b/);
  }, 60_000);
});
