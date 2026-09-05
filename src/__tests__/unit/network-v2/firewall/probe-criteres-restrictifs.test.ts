/**
 * Deux criteres RESTRICTIFS etaient acceptes, rendus, et jamais
 * evalues — donc le pare-feu laissait passer plus large que ce que
 * l'operateur avait ecrit.
 *
 * `set exclude enable` + `set exclude-member "POSTE-A"` sur un groupe
 * d'adresses : `onCommit` appelait `addAddressGroup(cle, membres,
 * commentaire)` et l'exclusion n'allait nulle part. Mesure avant
 * correctif : `matchesAddress('AUTORISES', '10.1.1.10')` rend `true`
 * pour l'adresse EXCLUE, et l'hote exclu traverse la politique
 * `set srcaddr "AUTORISES"` avec `0% packet loss`. L'operateur avait
 * ecrit « tout le LAN sauf ce poste », la machine repondait « tout le
 * LAN ».
 *
 * `set srcintf-filter` sur un VIP — « Interfaces to which the VIP
 * applies », dit la reference — etait declare et jete de la meme
 * facon, si bien que le VIP s'appliquait sur TOUTES les interfaces, y
 * compris celles que l'operateur venait d'exclure en le restreignant.
 *
 * **C'est la posture d'echec que ce depot interdit**, et elle vaut
 * d'etre nommee : un critere qu'un moteur de correspondance ne sait pas
 * decider doit rendre l'entree NON correspondante ; ici il etait
 * ignore, ce qui rend l'entree PLUS PERMISSIVE que ce qui est ecrit.
 * Les deux vivent en outre dans une commande rendue par `show`, donc
 * rejouee a l'import d'une topologie : la configuration se transporte,
 * l'effet non.
 *
 * **`extintf` etait deja lu, `srcintf-filter` non**, et les deux
 * restreignent l'interface d'entree. Plutot qu'une seconde liste a cote
 * de la premiere, les deux alimentent le MEME champ `fromZone` par leur
 * INTERSECTION : un paquet doit satisfaire les deux, ce qui est
 * exactement ce que les deux commandes disent chacune de leur cote.
 *
 * **`exclude-member` n'est offert que sous `exclude enable`**, comme
 * sur une vraie machine : un membre d'exclusion pose sans avoir arme
 * l'exclusion serait un troisieme critere stocke et non evalue, celui
 * qu'on vient de refermer.
 *
 * Discrimine par `git stash push -- src/network/` : 5 des 10 cas
 * tombent — j'en avais annonce 6, et la mesure corrige. Les 5 qui
 * passent des deux cotes sont nommes ici :
 *
 *   - « sans exclusion le poste traverse » et « sans filtre, le VIP
 *     traduit le trafic arrivant sur port2 » sont les deux TEMOINS, un
 *     par defaut mesure, et ils sont indispensables : sans eux, un
 *     laboratoire qui ne relaie pas et un critere qui fonctionne
 *     seraient indiscernables ;
 *   - « l_exclusion est acceptee et rendue » et « srcintf-filter est
 *     accepte et rendu » passaient deja, et c'est l'enonce meme du
 *     defaut : acceptes, rendus, lus par personne ;
 *   - « une adresse hors exclusion matche toujours » est le cas de
 *     non-regression, celui qui prouve que l'exclusion n'a pas ete
 *     payee en cassant l'appartenance.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { FortiGate } from '@/network/devices/firewall/vendors/fortios/FortiGate';
import type { FortiShell } from '@/network/devices/firewall/vendors/fortios/FortiShell';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { Cable } from '@/network/hardware/Cable';
import { resetCounters, MACAddress } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  MACAddress.resetCounter();
  Logger.reset();
});

interface Cmd { executeCommand(command: string): Promise<string> }

async function runOn(device: Cmd, ...commands: string[]): Promise<string> {
  let last = '';
  for (const command of commands) last = await device.executeCommand(command);
  return last;
}

function run(sh: FortiShell, ...lines: string[]): string {
  let last = '';
  for (const line of lines) last = sh.execute(line);
  return last;
}

const EXCLUSION = Object.freeze([
  'set exclude enable', 'set exclude-member "POSTE-A"',
]);

async function laboratoire(exclusion: readonly string[] = []) {
  const fw = new FortiGate('firewall-fortinet', 'FGT', 0, 0);
  const sh = fw.getShell() as FortiShell;
  const a = new LinuxPC('linux-pc', 'A', 200, 0);
  const b = new LinuxPC('linux-pc', 'B', 200, 100);
  a.powerOn();
  b.powerOn();
  new Cable('c1').connect(fw.getPort('port1')!, a.getPorts()[0]);
  new Cable('c2').connect(fw.getPort('port2')!, b.getPorts()[0]);

  run(sh, 'config system interface',
    'edit "port1"', 'set mode static', 'set ip 10.1.1.1 255.255.255.0', 'next',
    'edit "port2"', 'set mode static', 'set ip 10.2.2.1 255.255.255.0', 'next', 'end',
    'config firewall address',
    'edit "LAN"', 'set subnet 10.1.1.0 255.255.255.0', 'next',
    'edit "POSTE-A"', 'set subnet 10.1.1.10 255.255.255.255', 'next', 'end',
    'config firewall addrgrp', 'edit "AUTORISES"',
    'set member "LAN"', ...exclusion, 'next', 'end',
    'config firewall policy', 'edit 1',
    'set srcintf "port1"', 'set dstintf "port2"',
    'set srcaddr "AUTORISES"', 'set dstaddr "all"',
    'set action accept', 'set schedule "always"', 'set service "ALL"', 'next', 'end');

  await runOn(a, 'ip link set eth0 up', 'ip addr add 10.1.1.10/24 dev eth0',
    'ip route add default via 10.1.1.1');
  await runOn(b, 'ip link set eth0 up', 'ip addr add 10.2.2.10/24 dev eth0',
    'ip route add default via 10.2.2.1');

  return { fw, sh, a, b };
}

async function laboratoireVip(filtre: readonly string[] = []) {
  const labo = await laboratoire();
  run(labo.sh, 'config firewall vip', 'edit "WEB"',
    'set extip 10.2.2.100', 'set mappedip 10.1.1.10', ...filtre, 'next', 'end',
    'config firewall policy', 'edit 2',
    'set srcintf "port2"', 'set dstintf "port1"',
    'set srcaddr "all"', 'set dstaddr "WEB"',
    'set action accept', 'set schedule "always"', 'set service "ALL"', 'next', 'end');
  return labo;
}

describe('les criteres restrictifs sont evalues', () => {
  it('sans exclusion le poste traverse', async () => {
    const labo = await laboratoire();

    expect(await runOn(labo.a, 'ping -c 2 10.2.2.10')).toContain(', 0% packet loss');
  }, 25000);

  it('l_exclusion est acceptee et rendue', async () => {
    const labo = await laboratoire(EXCLUSION);
    const rendered = labo.sh.execute('show firewall addrgrp');

    expect(rendered).toContain('set exclude enable');
    expect(rendered).toContain('set exclude-member "POSTE-A"');
  }, 25000);

  it('le groupe ne matche plus l_adresse exclue', async () => {
    const labo = await laboratoire(EXCLUSION);

    expect(labo.fw.getObjectStore().matchesAddress('AUTORISES', '10.1.1.10')).toBe(false);
  }, 25000);

  it('une adresse hors exclusion matche toujours', async () => {
    const labo = await laboratoire(EXCLUSION);

    expect(labo.fw.getObjectStore().matchesAddress('AUTORISES', '10.1.1.20')).toBe(true);
  }, 25000);

  it('le poste exclu est refuse par la politique', async () => {
    const labo = await laboratoire(EXCLUSION);

    expect(await runOn(labo.a, 'ping -c 2 10.2.2.10')).toContain(', 100% packet loss');
  }, 25000);

  it('l_exclusion est portee par le magasin d_objets', async () => {
    const labo = await laboratoire(EXCLUSION);

    expect(labo.fw.getObjectStore().getAddressGroup('AUTORISES')?.exclusions)
      .toEqual(['POSTE-A']);
  }, 25000);

  it('exclude-member est refuse tant que exclude n_est pas arme', async () => {
    const labo = await laboratoire();

    const refusal = run(labo.sh, 'config firewall addrgrp', 'edit "AUTORISES"',
      'set exclude-member "POSTE-A"');
    labo.sh.execute('abort');

    expect(refusal).toContain('exclude-member');
  }, 25000);

  it('srcintf-filter est accepte et rendu', async () => {
    const labo = await laboratoireVip(['set srcintf-filter "port3"']);

    expect(labo.sh.execute('show firewall vip')).toContain('set srcintf-filter "port3"');
  }, 25000);

  it('sans filtre, le VIP traduit le trafic arrivant sur port2', async () => {
    const labo = await laboratoireVip();

    expect(await runOn(labo.b, 'ping -c 2 10.2.2.100')).toContain(', 0% packet loss');
  }, 25000);

  it('restreint a port3, le VIP ne traduit plus le trafic de port2', async () => {
    const labo = await laboratoireVip(['set srcintf-filter "port3"']);

    expect(await runOn(labo.b, 'ping -c 2 10.2.2.100')).toContain(', 100% packet loss');
  }, 25000);
});
