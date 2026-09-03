/**
 * `local-in-policy` garde le pare-feu LUI-MEME, et il n'y a pas de refus
 * implicite au bout de la liste.
 *
 * Ecrit A L'AVEUGLE, contre `official_docs/forti-cli-ref-60.txt` p. 219
 * et la documentation d'administration de Fortinet.
 *
 * Constat de depart : `FirewallProfile.selfTrafficHandling` vaut
 * `'local-in-policy'` sur le profil FortiOS, `'control-plane-acl'` sur
 * celui d'ASA — et n'est LU nulle part. Le mecanisme qu'il nomme
 * n'existe pas. Le seul filtre du trafic destine au pare-feu est
 * aujourd'hui `allowaccess`, qui ne connait ni adresse source, ni
 * service, ni horaire : on peut ouvrir SSH sur une interface, on ne peut
 * pas l'ouvrir a une seule machine.
 *
 * **La regle qu'il ne faut pas rater, et l'inverse etait aussi
 * plausible** : Fortinet ecrit mot pour mot « Unlike IPv4 policies,
 * there is no default implicit deny policy. The implicit deny policy
 * should be placed at the bottom of the list of local-in-policies. »
 * Une liste de politiques local-in ne se termine donc PAS par un refus.
 * Ce qui ne correspond a rien retombe sur `allowaccess`, et c'est ce qui
 * rend la fonction ADDITIVE — poser une seule politique d'autorisation
 * ne doit pas couper toutes les autres. Deux faits voisins et distincts,
 * que confondre serait le defaut : l'ACTION par defaut d'une politique
 * qu'on cree sans le dire est `deny` (« default = deny » dans la
 * reference), mais l'issue par defaut de la LISTE n'est pas un refus.
 *
 * Les TEMOINS sont donc, dans les deux sens : sans aucune politique
 * local-in, le trafic d'administration passe comme avant ; et une
 * politique local-in ne doit rien changer au trafic de TRANSIT, qui
 * releve de `firewall policy`.
 *
 * Discrimination en DEUX temps, chacune mesuree.
 *
 * Contre l'etat d'AVANT le lot, 5 cas tombent : les 4 qui observent un
 * refus applique, plus `show firewall local-in-policy`, que la CLI
 * refusait par `Command fail. Return code -61`.
 *
 * En ne retirant que la porte du plan de donnees — la ligne de
 * `l3/LocalDelivery.ts` — 4 tombent, et c'est exact : le cinquieme est
 * l'affaire du schema, pas de la porte. Les 8 qui passent des deux
 * cotes sont nommes ici plutot que laisses a decouvrir : les 2 TEMOINS
 * sans politique, les 2 TEMOINS d'interface et de transit, le cas
 * « ne correspond a rien » et le cas « desactivee » — ces quatre
 * derniers passent aussi AVANT le lot, parce qu'une fonction qui
 * n'existe pas ne bloque rien ; ils gardent le correctif contre un
 * exces de zele, ils ne prouvent pas la fonction. Restent le cas de
 * l'ordre (une autorisation avant un refus) et le TEMOIN de la premiere
 * suite, qui n'ont jamais eu besoin de la porte pour repondre.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { FortiGate } from '@/network/devices/firewall/vendors/fortios/FortiGate';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { Cable } from '@/network/hardware/Cable';
import { resetCounters, MACAddress } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';

interface Cmd { executeCommand(cmd: string): Promise<string> }

async function taper(d: Cmd, cmds: string[]): Promise<string[]> {
  const out: string[] = [];
  for (const c of cmds) out.push(await d.executeCommand(c));
  return out;
}

beforeEach(() => {
  resetCounters(); resetDeviceCounters(); MACAddress.resetCounter(); Logger.reset();
});

async function laboratoire() {
  const fgt = new FortiGate('firewall-fortinet', 'FGT-01', 0, 0);
  const admin = new LinuxPC('linux-pc', 'ADMIN', -200, 0);
  const intrus = new LinuxPC('linux-pc', 'INTRUS', -200, 120);
  const srv = new LinuxServer('linux-server', 'SRV-DMZ', 200, 0);

  new Cable('lan-admin').connect(admin.getPort('eth0')!, fgt.getPort('port2')!);
  new Cable('lan-intrus').connect(intrus.getPort('eth0')!, fgt.getPort('port4')!);
  new Cable('dmz').connect(fgt.getPort('port3')!, srv.getPort('eth0')!);

  await taper(admin, [
    'ip addr add 192.168.10.10/24 dev eth0', 'ip link set eth0 up',
    'ip route add default via 192.168.10.1',
  ]);
  await taper(intrus, [
    'ip addr add 192.168.30.10/24 dev eth0', 'ip link set eth0 up',
    'ip route add default via 192.168.30.1',
  ]);
  await taper(srv, [
    'ip addr add 192.168.20.10/24 dev eth0', 'ip link set eth0 up',
    'ip route add default via 192.168.20.1',
  ]);

  await taper(fgt, [
    'config system interface',
    'edit port2', 'set mode static',
    'set ip 192.168.10.1 255.255.255.0', 'set allowaccess ping ssh https', 'next',
    'edit port3', 'set mode static',
    'set ip 192.168.20.1 255.255.255.0', 'set allowaccess ping', 'next',
    'edit port4', 'set mode static',
    'set ip 192.168.30.1 255.255.255.0', 'set allowaccess ping ssh https', 'next', 'end',
    'config firewall address',
    'edit "POSTE-ADMIN"', 'set subnet 192.168.10.10 255.255.255.255', 'next',
    'edit "LAN-INTRUS"', 'set subnet 192.168.30.0 255.255.255.0', 'next', 'end',
    'config firewall policy', 'edit 1', 'set name "LAN-DMZ"',
    'set srcintf "port2"', 'set dstintf "port3"',
    'set srcaddr "all"', 'set dstaddr "all"', 'set service "ALL"',
    'set action accept', 'next', 'end',
  ]);
  return { fgt, admin, intrus, srv };
}

const REUSSI = /, 0% packet loss/;
const PERDU = /100% packet loss/;

describe('sans politique local-in, rien ne change', () => {
  it('TEMOIN: les deux postes atteignent le pare-feu', async () => {
    const { admin, intrus } = await laboratoire();

    expect(await admin.executeCommand('ping -c 1 192.168.10.1')).toMatch(REUSSI);
    expect(await intrus.executeCommand('ping -c 1 192.168.30.1')).toMatch(REUSSI);
  });

  it('TEMOIN: le transit LAN vers DMZ fonctionne', async () => {
    const { admin } = await laboratoire();

    expect(await admin.executeCommand('ping -c 1 192.168.20.10')).toMatch(REUSSI);
  });
});

describe('une politique local-in de refus bloque le trafic vers le pare-feu', () => {
  it('un refus sur port4 coupe le ping de l intrus', async () => {
    const { fgt, intrus } = await laboratoire();

    await taper(fgt, [
      'config firewall local-in-policy', 'edit 1',
      'set intf "port4"',
      'set srcaddr "all"', 'set dstaddr "all"', 'set service "ALL"',
      'set action deny', 'set schedule "always"', 'next', 'end',
    ]);

    expect(await intrus.executeCommand('ping -c 1 192.168.30.1')).toMatch(PERDU);
  });

  it('TEMOIN: ce refus ne touche PAS l autre interface', async () => {
    const { fgt, admin } = await laboratoire();

    await taper(fgt, [
      'config firewall local-in-policy', 'edit 1',
      'set intf "port4"',
      'set srcaddr "all"', 'set dstaddr "all"', 'set service "ALL"',
      'set action deny', 'set schedule "always"', 'next', 'end',
    ]);

    expect(await admin.executeCommand('ping -c 1 192.168.10.1')).toMatch(REUSSI);
  });

  it('TEMOIN: ce refus ne touche PAS le trafic de transit', async () => {
    const { fgt, admin } = await laboratoire();

    await taper(fgt, [
      'config firewall local-in-policy', 'edit 1',
      'set intf "port2"',
      'set srcaddr "all"', 'set dstaddr "all"', 'set service "ALL"',
      'set action deny', 'set schedule "always"', 'next', 'end',
    ]);

    expect(await admin.executeCommand('ping -c 1 192.168.20.10')).toMatch(REUSSI);
  });
});

describe('il n y a PAS de refus implicite au bout de la liste', () => {
  it('une politique qui ne correspond a rien laisse passer le reste', async () => {
    const { fgt, admin } = await laboratoire();

    await taper(fgt, [
      'config firewall local-in-policy', 'edit 1',
      'set intf "port4"',
      'set srcaddr "LAN-INTRUS"', 'set dstaddr "all"', 'set service "ALL"',
      'set action deny', 'set schedule "always"', 'next', 'end',
    ]);

    expect(await admin.executeCommand('ping -c 1 192.168.10.1')).toMatch(REUSSI);
  });

  it('un refus general se pose donc a la MAIN, et il mord', async () => {
    const { fgt, admin, intrus } = await laboratoire();

    await taper(fgt, [
      'config firewall local-in-policy',
      'edit 1', 'set intf "port2"', 'set srcaddr "POSTE-ADMIN"',
      'set dstaddr "all"', 'set service "ALL"',
      'set action accept', 'set schedule "always"', 'next',
      'edit 2', 'set intf "any"', 'set srcaddr "all"',
      'set dstaddr "all"', 'set service "ALL"',
      'set action deny', 'set schedule "always"', 'next', 'end',
    ]);

    expect(await admin.executeCommand('ping -c 1 192.168.10.1')).toMatch(REUSSI);
    expect(await intrus.executeCommand('ping -c 1 192.168.30.1')).toMatch(PERDU);
  });
});

describe('la premiere politique qui correspond decide', () => {
  it('une autorisation placee AVANT le refus l emporte', async () => {
    const { fgt, intrus } = await laboratoire();

    await taper(fgt, [
      'config firewall local-in-policy',
      'edit 1', 'set intf "port4"', 'set srcaddr "LAN-INTRUS"',
      'set dstaddr "all"', 'set service "ALL"',
      'set action accept', 'set schedule "always"', 'next',
      'edit 2', 'set intf "port4"', 'set srcaddr "all"',
      'set dstaddr "all"', 'set service "ALL"',
      'set action deny', 'set schedule "always"', 'next', 'end',
    ]);

    expect(await intrus.executeCommand('ping -c 1 192.168.30.1')).toMatch(REUSSI);
  });

  it('une politique desactivee ne decide de rien', async () => {
    const { fgt, intrus } = await laboratoire();

    await taper(fgt, [
      'config firewall local-in-policy', 'edit 1',
      'set intf "port4"', 'set srcaddr "all"', 'set dstaddr "all"',
      'set service "ALL"', 'set action deny', 'set schedule "always"',
      'set status disable', 'next', 'end',
    ]);

    expect(await intrus.executeCommand('ping -c 1 192.168.30.1')).toMatch(REUSSI);
  });
});

describe('le service est un critere, pas seulement l interface', () => {
  it('refuser PING laisse SSH ouvert', async () => {
    const { fgt, intrus } = await laboratoire();

    await taper(fgt, [
      'config firewall local-in-policy', 'edit 1',
      'set intf "port4"', 'set srcaddr "all"', 'set dstaddr "all"',
      'set service "PING"', 'set action deny', 'set schedule "always"',
      'next', 'end',
    ]);

    expect(await intrus.executeCommand('ping -c 1 192.168.30.1')).toMatch(PERDU);
    expect(fgt.allowedAccessOn('port4')).toContain('ssh');
  });
});

describe('la configuration se relit', () => {
  it('show firewall local-in-policy rend ce qui a ete tape', async () => {
    const { fgt } = await laboratoire();

    await taper(fgt, [
      'config firewall local-in-policy', 'edit 1',
      'set intf "port4"', 'set srcaddr "LAN-INTRUS"', 'set dstaddr "all"',
      'set service "PING"', 'set action deny', 'set schedule "always"',
      'set comments "bloque le lab intrus"', 'next', 'end',
    ]);

    const out = await fgt.executeCommand('show firewall local-in-policy');

    expect(out).toContain('config firewall local-in-policy');
    expect(out).toContain('edit 1');
    expect(out).toContain('set intf "port4"');
    expect(out).toContain('set srcaddr "LAN-INTRUS"');
    expect(out).toContain('set service "PING"');
    expect(out).toContain('set comments "bloque le lab intrus"');
  });

  it('l action par defaut d une politique est deny', async () => {
    const { fgt, intrus } = await laboratoire();

    await taper(fgt, [
      'config firewall local-in-policy', 'edit 1',
      'set intf "port4"', 'set srcaddr "all"', 'set dstaddr "all"',
      'set service "ALL"', 'set schedule "always"', 'next', 'end',
    ]);

    expect(await intrus.executeCommand('ping -c 1 192.168.30.1')).toMatch(PERDU);
  });
});
