/**
 * Phase 3 : la traduction d'adresses complete — et les laboratoires L2 et L11.
 *
 * Ecrite A L'AVEUGLE contre ce qu'un vrai FortiGate fait, verifie contre
 * la documentation Fortinet avant d'ecrire une ligne de produit.
 *
 * Quatre points ne sont pas cosmetiques et decident de la suite :
 *
 *   1. **Une VIP est joignable parce que le pare-feu REPOND a l'ARP.**
 *      `arp-reply` vaut `enable` par defaut sur `firewall vip` comme sur
 *      `firewall ippool` : sans reponse ARP mandataire, l'adresse
 *      publique n'appartient a personne sur le lien et aucun paquet
 *      n'arrive jamais. Le couper doit rendre la VIP injoignable, sinon
 *      le reglage est un decor.
 *   2. **La traduction de destination a lieu AVANT la politique**, et la
 *      politique nomme la VIP dans `dstaddr`. Une VIP est donc a la fois
 *      un objet adresse et une regle NAT, et l'objet doit correspondre a
 *      l'adresse INTERNE puisque le paquet porte deja celle-la quand la
 *      politique le regarde.
 *   3. **`match-vip` vaut `enable` par defaut depuis la 7.2.3** et
 *      n'existe que sur une regle `deny` : une regle de blocage placee
 *      au-dessus ATTRAPE donc le trafic d'une VIP, et c'est en la
 *      desactivant qu'on l'en dispense. L'inverse — le defaut d'avant
 *      7.2.3 — se serait ecrit tout aussi naturellement et aurait ete
 *      faux pour la version que ce simulateur annonce.
 *   4. **`central-nat enable` RETIRE `set nat` de la politique.** Les
 *      deux mecanismes ne coexistent pas ; laisser les deux ouverts
 *      donnerait deux reponses possibles a « qui traduit la source ? ».
 *
 * Discriminee par `git stash push -- src/network/` : 27 des 34 cas
 * tombent avant correctif. Les 7 restants sont nommes ici plutot que
 * laisses a decouvrir, et aucun ne prouve le mecanisme :
 *
 *   - « sans politique, la VIP ne mene nulle part », « sans entree
 *     centrale correspondante, rien n'est traduit » et « une regle de
 *     blocage attrape le trafic d'une VIP par defaut » passaient parce
 *     que la VIP et la table centrale n'existaient pas du tout ;
 *   - « `action deny` renvoie a la table de routage » passait parce
 *     qu'aucune route de politique ne pouvait detourner quoi que ce
 *     soit, et « n'existe pas sur une regle qui accepte » parce que
 *     `match-vip` etait refuse partout ;
 *   - « sans pool, la source prend l'adresse de l'interface de sortie »
 *     et « sans route de politique, la table de routage decide » sont
 *     les deux temoins de non-regression, dont c'est l'objet de passer
 *     des deux cotes.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { FortiGate } from '@/network/devices/firewall/vendors/fortios/FortiGate';
import { FortiShell } from '@/network/devices/firewall/vendors/fortios/FortiShell';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { GenericSwitch } from '@/network/devices/GenericSwitch';
import { Cable } from '@/network/hardware/Cable';
import { resetCounters, MACAddress } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { pingOnSimulatedClock } from '../../../support/fastPing';

interface Cmd { executeCommand(cmd: string): Promise<string> }
const runOn = (d: Cmd, cmds: string[]) =>
  cmds.reduce(async (p, c) => { await p; await d.executeCommand(c); }, Promise.resolve<unknown>(undefined));

function run(sh: FortiShell, ...lines: string[]): string {
  let last = '';
  for (const line of lines) last = sh.execute(line);
  return last;
}

function shell(): { fw: FortiGate; sh: FortiShell } {
  resetCounters(); resetDeviceCounters(); MACAddress.resetCounter(); Logger.reset();
  const fw = new FortiGate('firewall-fortinet', 'FGT1', 0, 0);
  return { fw, sh: new FortiShell(fw) };
}

async function laboratoire() {
  const { fw, sh } = shell();
  const serveur = new LinuxPC('linux-pc', 'SRV', -100, 0);
  const client = new LinuxPC('linux-pc', 'CLIENT', 100, 0);

  new Cable('a').connect(serveur.getPort('eth0')!, fw.getPort('port1')!);
  new Cable('b').connect(fw.getPort('port2')!, client.getPort('eth0')!);

  run(sh,
    'config system interface',
    'edit "port1"', 'set alias "DMZ"', 'set mode static',
    'set ip 192.168.1.1 255.255.255.0', 'set allowaccess ping', 'next',
    'edit "port2"', 'set alias "WAN"', 'set mode static',
    'set ip 203.0.113.1 255.255.255.0', 'set allowaccess ping', 'next', 'end',
    'config router static', 'edit 1',
    'set dst 0.0.0.0 0.0.0.0', 'set gateway 203.0.113.254', 'set device "port2"',
    'next', 'end');

  await runOn(serveur, ['ip link set eth0 up', 'ip addr add 192.168.1.10/24 dev eth0',
    'ip route add default via 192.168.1.1']);
  await runOn(client, ['ip link set eth0 up', 'ip addr add 203.0.113.50/24 dev eth0',
    'ip route add default via 203.0.113.1']);

  return { fw, sh, serveur, client };
}

async function laboratoireHairpin() {
  const { fw, sh } = shell();
  const serveur = new LinuxPC('linux-pc', 'SRV', -100, 0);
  const poste = new LinuxPC('linux-pc', 'POSTE', -100, 100);
  const commutateur = new GenericSwitch('switch-generic', 'SW', 8, -50, 50);

  new Cable('a').connect(serveur.getPort('eth0')!, commutateur.getPort('eth0')!);
  new Cable('b').connect(poste.getPort('eth0')!, commutateur.getPort('eth1')!);
  new Cable('c').connect(commutateur.getPort('eth2')!, fw.getPort('port1')!);

  run(sh,
    'config system interface',
    'edit "port1"', 'set mode static',
    'set ip 192.168.1.1 255.255.255.0', 'set allowaccess ping', 'next', 'end');

  await runOn(serveur, ['ip link set eth0 up', 'ip addr add 192.168.1.10/24 dev eth0',
    'ip route add default via 192.168.1.1']);
  await runOn(poste, ['ip link set eth0 up', 'ip addr add 192.168.1.20/24 dev eth0',
    'ip route add default via 192.168.1.1']);

  return { fw, sh, serveur, poste };
}

function vipStatique(sh: FortiShell, externe = '203.0.113.100'): void {
  run(sh,
    'config firewall vip',
    'edit "VIP_WEB"',
    `set extip ${externe}`,
    'set mappedip "192.168.1.10"',
    'set extintf "port2"',
    'next', 'end');
}

function politiqueVersVip(sh: FortiShell, id = '1'): void {
  run(sh,
    'config firewall policy',
    `edit ${id}`,
    'set name "WAN-vers-DMZ"',
    'set srcintf "port2"', 'set dstintf "port1"',
    'set srcaddr "all"', 'set dstaddr "VIP_WEB"',
    'set action accept', 'set schedule "always"', 'set service "ALL"',
    'next', 'end');
}

beforeEach(() => { Logger.reset(); });

describe('config firewall ippool', () => {
  it('accepte un pool et rend ce qui a ete tape', async () => {
    const { sh } = await laboratoire();

    run(sh, 'config firewall ippool', 'edit "POOL_SORTIE"',
      'set startip 203.0.113.200', 'set endip 203.0.113.210', 'next', 'end');

    const vu = run(sh, 'show firewall ippool');
    expect(vu).toContain('edit "POOL_SORTIE"');
    expect(vu).toContain('set startip 203.0.113.200');
    expect(vu).toContain('set endip 203.0.113.210');
  });

  it('`get` annonce le type overload et l\'ARP mandataire par defaut', async () => {
    const { sh } = await laboratoire();

    run(sh, 'config firewall ippool', 'edit "POOL_SORTIE"',
      'set startip 203.0.113.200', 'set endip 203.0.113.210', 'next', 'end');

    const vu = run(sh, 'get firewall ippool POOL_SORTIE');
    expect(vu).toMatch(/^type\s+: overload$/m);
    expect(vu).toMatch(/^arp-reply\s+: enable$/m);
  });

  it('`source-startip` ne s\'applique pas a un pool overload', async () => {
    const { sh } = await laboratoire();

    run(sh, 'config firewall ippool', 'edit "P"', 'set startip 203.0.113.200');
    const refus = run(sh, 'set source-startip 192.168.1.0');

    expect(refus).not.toBe('');
    expect(refus.toLowerCase()).toContain('source-startip');
  });

  it('`block-size` n\'existe que pour un pool a blocs de ports', async () => {
    const { sh } = await laboratoire();

    run(sh, 'config firewall ippool', 'edit "P"', 'set startip 203.0.113.200');
    const refuse = run(sh, 'set block-size 128');
    run(sh, 'set type port-block-allocation');
    const accepte = run(sh, 'set block-size 128');

    expect(refuse).not.toBe('');
    expect(accepte).toBe('');
  });

  it('le pool existe vraiment sur l\'equipement', async () => {
    const { fw, sh } = await laboratoire();

    run(sh, 'config firewall ippool', 'edit "POOL_SORTIE"',
      'set startip 203.0.113.200', 'set endip 203.0.113.210', 'next', 'end');

    expect(fw.getIpPools().names()).toContain('POOL_SORTIE');
    expect(fw.getIpPools().get('POOL_SORTIE')?.endIP).toBe('203.0.113.210');
  });

  it('un pool arme l\'ARP mandataire sur toute sa plage', async () => {
    const { fw, sh } = await laboratoire();

    run(sh, 'config firewall ippool', 'edit "POOL_SORTIE"',
      'set startip 203.0.113.200', 'set endip 203.0.113.210',
      'set arp-intf "port2"', 'next', 'end');

    expect(fw.proxyArpAnswers('203.0.113.205', 'port2')).toBe(true);
    expect(fw.proxyArpAnswers('203.0.113.211', 'port2')).toBe(false);
  });

  it('`arp-reply disable` retire le pool de l\'ARP mandataire', async () => {
    const { fw, sh } = await laboratoire();

    run(sh, 'config firewall ippool', 'edit "POOL_SORTIE"',
      'set startip 203.0.113.200', 'set endip 203.0.113.210',
      'set arp-reply disable', 'next', 'end');

    expect(fw.proxyArpAnswers('203.0.113.205', 'port2')).toBe(false);
  });
});

describe('config firewall vip', () => {
  it('rend ce qui a ete tape', async () => {
    const { sh } = await laboratoire();
    vipStatique(sh);

    const vu = run(sh, 'show firewall vip');
    expect(vu).toContain('edit "VIP_WEB"');
    expect(vu).toContain('set extip 203.0.113.100');
    expect(vu).toContain('set mappedip "192.168.1.10"');
  });

  it('`protocol` et `extport` n\'existent que si le renvoi de port est arme', async () => {
    const { sh } = await laboratoire();

    run(sh, 'config firewall vip', 'edit "V"',
      'set extip 203.0.113.100', 'set mappedip "192.168.1.10"');
    const refuse = run(sh, 'set extport 8080');
    run(sh, 'set portforward enable');
    const accepte = run(sh, 'set extport 8080');

    expect(refuse).not.toBe('');
    expect(accepte).toBe('');
  });

  it('devient une adresse utilisable comme destination d\'une politique', async () => {
    const { sh } = await laboratoire();
    vipStatique(sh);

    const refus = run(sh, 'config firewall policy', 'edit 1',
      'set srcintf "port2"', 'set dstintf "port1"',
      'set srcaddr "all"', 'set dstaddr "VIP_WEB"');

    expect(refus).toBe('');
  });

  it('l\'adresse de la VIP designe le serveur INTERNE, la politique la voyant apres traduction', async () => {
    const { fw, sh } = await laboratoire();
    vipStatique(sh);

    expect(fw.getObjectStore().matchesAddress('VIP_WEB', '192.168.1.10')).toBe(true);
  });

  it('le pare-feu repond a l\'ARP pour l\'adresse publique de la VIP', async () => {
    const { fw, sh } = await laboratoire();
    vipStatique(sh);

    expect(fw.getArpService().answersFor('203.0.113.100', 'port2')).toBe(true);
  });

  it('`arp-reply disable` retire cette reponse', async () => {
    const { fw, sh } = await laboratoire();
    vipStatique(sh);

    run(sh, 'config firewall vip', 'edit "VIP_WEB"', 'set arp-reply disable', 'next', 'end');

    expect(fw.getArpService().answersFor('203.0.113.100', 'port2')).toBe(false);
  });

  it('L2 : un client d\'Internet joint le serveur interne par la VIP', async () => {
    const { sh, client } = await laboratoire();
    vipStatique(sh);
    politiqueVersVip(sh);

    const vu = await pingOnSimulatedClock(client, 'ping -c 2 203.0.113.100');

    expect(vu).toMatch(/, 0% packet loss/);
  });

  it('sans politique, la VIP ne mene nulle part', async () => {
    const { sh, client } = await laboratoire();
    vipStatique(sh);

    const vu = await pingOnSimulatedClock(client, 'ping -c 2 203.0.113.100');

    expect(vu).toMatch(/, 100% packet loss/);
  });

  it('le renvoi de port traduit le port declare et lui seul', async () => {
    const { fw, sh } = await laboratoire();

    run(sh, 'config firewall vip', 'edit "VIP_WEB"',
      'set extip 203.0.113.100', 'set mappedip "192.168.1.10"',
      'set extintf "port2"', 'set portforward enable',
      'set protocol tcp', 'set extport 8080', 'set mappedport 80', 'next', 'end');
    politiqueVersVip(sh);

    const attendu = fw.simulate({
      ingressPort: 'port2', protocol: 'tcp',
      sourceIP: '203.0.113.50', destinationIP: '203.0.113.100',
      sourcePort: 40000, destinationPort: 8080,
    });
    const autre = fw.simulate({
      ingressPort: 'port2', protocol: 'tcp',
      sourceIP: '203.0.113.50', destinationIP: '203.0.113.100',
      sourcePort: 40000, destinationPort: 9999,
    });

    expect(attendu.translatedDestinationIP).toBe('192.168.1.10');
    expect(attendu.translatedDestinationPort).toBe(80);
    expect(autre.translatedDestinationIP).toBe('203.0.113.100');
  });

  it('une VIP posee sur l\'adresse meme de l\'interface est traduite et non servie localement', async () => {
    const { fw, sh, client } = await laboratoire();
    vipStatique(sh, '203.0.113.1');
    politiqueVersVip(sh);

    const vu = await pingOnSimulatedClock(client, 'ping -c 2 203.0.113.1');
    const sessions = fw.getSessionTable().view().all();

    expect(vu).toMatch(/, 0% packet loss/);
    expect(sessions.some(s => s.translation?.translatedDest === '192.168.1.10')).toBe(true);
  });

  it('le trafic hairpin depuis le reseau interne traverse la meme VIP', async () => {
    const { fw, sh, poste } = await laboratoireHairpin();

    run(sh, 'config firewall vip', 'edit "VIP_WEB"',
      'set extip 203.0.113.100', 'set mappedip "192.168.1.10"', 'next', 'end');
    run(sh, 'config firewall policy', 'edit 1',
      'set srcintf "port1"', 'set dstintf "port1"',
      'set srcaddr "all"', 'set dstaddr "VIP_WEB"',
      'set action accept', 'set schedule "always"', 'set service "ALL"',
      'set nat enable', 'next', 'end');

    const vu = await pingOnSimulatedClock(poste, 'ping -c 2 203.0.113.100');
    const sessions = fw.getSessionTable().view().all();

    expect(vu).toMatch(/, 0% packet loss/);
    expect(sessions.some(s => s.translation?.translatedSource === '192.168.1.1')).toBe(true);
  });
});

describe('les pools de sortie dans une politique', () => {
  function laboratoireSortie(sh: FortiShell): void {
    run(sh,
      'config firewall ippool', 'edit "POOL_SORTIE"',
      'set startip 203.0.113.200', 'set endip 203.0.113.200', 'next', 'end',
      'config firewall policy', 'edit 1',
      'set srcintf "port1"', 'set dstintf "port2"',
      'set srcaddr "all"', 'set dstaddr "all"',
      'set action accept', 'set schedule "always"', 'set service "ALL"',
      'set nat enable', 'set ippool enable', 'set poolname "POOL_SORTIE"',
      'next', 'end');
  }

  it('`poolname` ne s\'applique pas tant que `ippool` est desactive', async () => {
    const { sh } = await laboratoire();

    run(sh, 'config firewall ippool', 'edit "P"',
      'set startip 203.0.113.200', 'next', 'end');
    run(sh, 'config firewall policy', 'edit 1', 'set nat enable');
    const refuse = run(sh, 'set poolname "P"');
    run(sh, 'set ippool enable');
    const accepte = run(sh, 'set poolname "P"');

    expect(refuse).not.toBe('');
    expect(accepte).toBe('');
  });

  it('L11 : la source prend l\'adresse du pool et non celle de l\'interface', async () => {
    const { fw, sh } = await laboratoire();
    laboratoireSortie(sh);

    const vu = fw.simulate({
      ingressPort: 'port1', protocol: 'tcp',
      sourceIP: '192.168.1.10', destinationIP: '198.51.100.7',
      sourcePort: 40000, destinationPort: 443,
    });

    expect(vu.allowed).toBe(true);
    expect(vu.translatedSourceIP).toBe('203.0.113.200');
  });

  it('sans pool, la source prend l\'adresse de l\'interface de sortie', async () => {
    const { fw, sh } = await laboratoire();
    run(sh, 'config firewall policy', 'edit 1',
      'set srcintf "port1"', 'set dstintf "port2"',
      'set srcaddr "all"', 'set dstaddr "all"',
      'set action accept', 'set schedule "always"', 'set service "ALL"',
      'set nat enable', 'next', 'end');

    const vu = fw.simulate({
      ingressPort: 'port1', protocol: 'tcp',
      sourceIP: '192.168.1.10', destinationIP: '198.51.100.7',
      sourcePort: 40000, destinationPort: 443,
    });

    expect(vu.translatedSourceIP).toBe('203.0.113.1');
  });

  it('un pool one-to-one garde le port de la source', async () => {
    const { fw, sh } = await laboratoire();
    run(sh,
      'config firewall ippool', 'edit "POOL_11"',
      'set type one-to-one',
      'set startip 203.0.113.200', 'set endip 203.0.113.201', 'next', 'end',
      'config firewall policy', 'edit 1',
      'set srcintf "port1"', 'set dstintf "port2"',
      'set srcaddr "all"', 'set dstaddr "all"',
      'set action accept', 'set schedule "always"', 'set service "ALL"',
      'set nat enable', 'set ippool enable', 'set poolname "POOL_11"',
      'next', 'end');

    const vu = fw.simulate({
      ingressPort: 'port1', protocol: 'tcp',
      sourceIP: '192.168.1.10', destinationIP: '198.51.100.7',
      sourcePort: 40000, destinationPort: 443,
    });

    expect(vu.translatedSourcePort).toBe(40000);
    expect(vu.translatedSourceIP).toBe('203.0.113.200');
  });
});

describe('config firewall central-snat-map', () => {
  it('`central-nat enable` retire `set nat` de la politique', async () => {
    const { sh } = await laboratoire();

    run(sh, 'config system settings', 'set central-nat enable', 'end');
    const refus = run(sh, 'config firewall policy', 'edit 1', 'set nat enable');

    expect(refus).not.toBe('');
  });

  it('une entree centrale traduit la source', async () => {
    const { fw, sh } = await laboratoire();

    run(sh,
      'config system settings', 'set central-nat enable', 'end',
      'config firewall ippool', 'edit "POOL_C"',
      'set startip 203.0.113.220', 'set endip 203.0.113.220', 'next', 'end',
      'config firewall central-snat-map', 'edit 1',
      'set srcintf "port1"', 'set dstintf "port2"',
      'set orig-addr "all"', 'set dst-addr "all"',
      'set nat enable', 'set nat-ippool "POOL_C"', 'next', 'end',
      'config firewall policy', 'edit 1',
      'set srcintf "port1"', 'set dstintf "port2"',
      'set srcaddr "all"', 'set dstaddr "all"',
      'set action accept', 'set schedule "always"', 'set service "ALL"',
      'next', 'end');

    const vu = fw.simulate({
      ingressPort: 'port1', protocol: 'tcp',
      sourceIP: '192.168.1.10', destinationIP: '198.51.100.7',
      sourcePort: 40000, destinationPort: 443,
    });

    expect(vu.allowed).toBe(true);
    expect(vu.translatedSourceIP).toBe('203.0.113.220');
  });

  it('sans entree centrale correspondante, rien n\'est traduit', async () => {
    const { fw, sh } = await laboratoire();

    run(sh,
      'config system settings', 'set central-nat enable', 'end',
      'config firewall policy', 'edit 1',
      'set srcintf "port1"', 'set dstintf "port2"',
      'set srcaddr "all"', 'set dstaddr "all"',
      'set action accept', 'set schedule "always"', 'set service "ALL"',
      'next', 'end');

    const vu = fw.simulate({
      ingressPort: 'port1', protocol: 'tcp',
      sourceIP: '192.168.1.10', destinationIP: '198.51.100.7',
      sourcePort: 40000, destinationPort: 443,
    });

    expect(vu.allowed).toBe(true);
    expect(vu.translatedSourceIP).toBe('192.168.1.10');
  });

  it('`show` reproduit l\'entree centrale', async () => {
    const { sh } = await laboratoire();

    run(sh,
      'config firewall ippool', 'edit "POOL_C"',
      'set startip 203.0.113.220', 'next', 'end',
      'config firewall central-snat-map', 'edit 1',
      'set srcintf "port1"', 'set dstintf "port2"',
      'set orig-addr "all"', 'set nat-ippool "POOL_C"', 'next', 'end');

    const vu = run(sh, 'show firewall central-snat-map');
    expect(vu).toContain('edit 1');
    expect(vu).toContain('set nat-ippool "POOL_C"');
  });
});

describe('config router policy', () => {
  function troisPortsRoutes(sh: FortiShell): void {
    run(sh,
      'config system interface',
      'edit "port3"', 'set mode static', 'set ip 198.51.100.1 255.255.255.0',
      'next', 'end',
      'config firewall policy', 'edit 1',
      'set srcintf "port1"', 'set dstintf "port2" "port3"',
      'set srcaddr "all"', 'set dstaddr "all"',
      'set action accept', 'set schedule "always"', 'set service "ALL"',
      'next', 'end');
  }

  it('detourne le trafic vers une autre interface que la table de routage', async () => {
    const { fw, sh } = await laboratoire();
    troisPortsRoutes(sh);

    run(sh, 'config router policy', 'edit 1',
      'set input-device "port1"',
      'set src "192.168.1.0/24"',
      'set output-device "port3"',
      'set gateway 198.51.100.254',
      'next', 'end');

    const vu = fw.simulate({
      ingressPort: 'port1', protocol: 'tcp',
      sourceIP: '192.168.1.10', destinationIP: '8.8.8.8',
      sourcePort: 40000, destinationPort: 443,
    });

    expect(vu.egressPort).toBe('port3');
  });

  it('sans route de politique, la table de routage decide', async () => {
    const { fw, sh } = await laboratoire();
    troisPortsRoutes(sh);

    const vu = fw.simulate({
      ingressPort: 'port1', protocol: 'tcp',
      sourceIP: '192.168.1.10', destinationIP: '8.8.8.8',
      sourcePort: 40000, destinationPort: 443,
    });

    expect(vu.egressPort).toBe('port2');
  });

  it('`action deny` renvoie a la table de routage', async () => {
    const { fw, sh } = await laboratoire();
    troisPortsRoutes(sh);

    run(sh, 'config router policy', 'edit 1',
      'set input-device "port1"', 'set src "192.168.1.0/24"',
      'set action deny', 'set output-device "port3"', 'next', 'end');

    const vu = fw.simulate({
      ingressPort: 'port1', protocol: 'tcp',
      sourceIP: '192.168.1.10', destinationIP: '8.8.8.8',
      sourcePort: 40000, destinationPort: 443,
    });

    expect(vu.egressPort).toBe('port2');
  });

  it('la plage de ports borne le detournement', async () => {
    const { fw, sh } = await laboratoire();
    troisPortsRoutes(sh);

    run(sh, 'config router policy', 'edit 1',
      'set input-device "port1"', 'set src "192.168.1.0/24"',
      'set protocol 6', 'set start-port 443', 'set end-port 443',
      'set output-device "port3"', 'next', 'end');

    const dans = fw.simulate({
      ingressPort: 'port1', protocol: 'tcp',
      sourceIP: '192.168.1.10', destinationIP: '8.8.8.8',
      sourcePort: 40000, destinationPort: 443,
    });
    const hors = fw.simulate({
      ingressPort: 'port1', protocol: 'tcp',
      sourceIP: '192.168.1.10', destinationIP: '8.8.8.8',
      sourcePort: 40000, destinationPort: 80,
    });

    expect(dans.egressPort).toBe('port3');
    expect(hors.egressPort).toBe('port2');
  });

  it('`show` reproduit la route de politique', async () => {
    const { sh } = await laboratoire();
    troisPortsRoutes(sh);

    run(sh, 'config router policy', 'edit 1',
      'set input-device "port1"', 'set src "192.168.1.0/24"',
      'set output-device "port3"', 'set gateway 198.51.100.254', 'next', 'end');

    const vu = run(sh, 'show router policy');
    expect(vu).toContain('edit 1');
    expect(vu).toContain('set gateway 198.51.100.254');
  });
});

describe('match-vip', () => {
  it('une regle de blocage attrape le trafic d\'une VIP par defaut', async () => {
    const { fw, sh } = await laboratoire();
    vipStatique(sh);

    run(sh, 'config firewall policy', 'edit 1',
      'set srcintf "port2"', 'set dstintf "port1"',
      'set srcaddr "all"', 'set dstaddr "all"',
      'set action deny', 'set schedule "always"', 'set service "ALL"',
      'next', 'end');
    politiqueVersVip(sh, '2');

    const vu = fw.simulate({
      ingressPort: 'port2', protocol: 'tcp',
      sourceIP: '203.0.113.50', destinationIP: '203.0.113.100',
      sourcePort: 40000, destinationPort: 80,
    });

    expect(vu.allowed).toBe(false);
  });

  it('`match-vip disable` l\'en dispense', async () => {
    const { fw, sh } = await laboratoire();
    vipStatique(sh);

    run(sh, 'config firewall policy', 'edit 1',
      'set srcintf "port2"', 'set dstintf "port1"',
      'set srcaddr "all"', 'set dstaddr "all"',
      'set action deny', 'set schedule "always"', 'set service "ALL"',
      'set match-vip disable',
      'next', 'end');
    politiqueVersVip(sh, '2');

    const vu = fw.simulate({
      ingressPort: 'port2', protocol: 'tcp',
      sourceIP: '203.0.113.50', destinationIP: '203.0.113.100',
      sourcePort: 40000, destinationPort: 80,
    });

    expect(vu.allowed).toBe(true);
  });

  it('n\'existe pas sur une regle qui accepte', async () => {
    const { sh } = await laboratoire();

    run(sh, 'config firewall policy', 'edit 1', 'set action accept');
    const refus = run(sh, 'set match-vip disable');

    expect(refus).not.toBe('');
  });
});
