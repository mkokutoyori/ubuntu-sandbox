/**
 * Un datagramme FRAGMENTE est recolle avant la politique.
 *
 * L'entree `[pare-feu] les fragments recus ne sont pas REASSEMBLES` de
 * `TODO.md` nomme le point. Son report — « il faut d'abord decider QUAND,
 * cette condition n'etant modelisee nulle part » — est re-mesure et
 * tombe : la documentation de Fortinet dit que la defragmentation existe
 * « so that policy can be applied to reassembled packets » et que le
 * chemin logiciel traite TOUS les fragments par defaut. La reponse est
 * donc « avant la recherche de politique, toujours », ce que fait deja
 * `Router.forwardPacket` avec la meme brique du socle.
 *
 * Ecrite A L'AVEUGLE contre ce que fait un vrai FortiGate :
 *
 *   1. Un datagramme fragmente ouvre UNE session, pas une par fragment.
 *   2. Il arrive ENTIER chez le serveur — c'est le seul cas qui prouve
 *      que le recollage a eu lieu et pas seulement que les fragments ont
 *      ete comptes ensemble.
 *   3. Une regle qui refuse le port refuse AUSSI le datagramme
 *      fragmente. Sans recollage, les fragments qui suivent le premier ne
 *      portent pas ce port et echappent a la regle qui les nomme : c'est
 *      l'evasion par fragmentation.
 *   4. `set ip-fragment-mem-thresholds` existe, vaut 32 par defaut, et
 *      accepte 32 a 2047 (megaoctets).
 *   5. Une valeur hors bornes est refusee plutot que rangee.
 *   6. `diagnose snmp ip frags` rend les compteurs de la MIB IP.
 *   7. Ces compteurs MESURENT : un recollage reussi fait monter
 *      `ReasmReqds` et `ReasmOKs`.
 *   8. Un jeu de fragments INCOMPLET n'est jamais transmis, et son
 *      expiration se compte (`ReasmTimeout`, `ReasmFails`).
 *   9. La borne memoire BORNE vraiment : trop de fragments en attente
 *      les fait perdre au lieu de s'accumuler sans fin.
 *  10. TEMOIN : un datagramme NON fragmente ne touche pas le
 *      reassembleur — ses compteurs restent a zero. Sans ce cas, un
 *      compteur qui monterait a chaque paquet passerait pour une mesure.
 *
 * La fragmentation vient d'un VRAI routeur intercale dont le lien de
 * sortie porte un petit MTU, pas d'un jeu de paquets fabrique a la main :
 * c'est la seule facon de savoir que ce qui arrive au pare-feu est bien
 * ce qu'un routeur produit.
 *
 * Discrimination (`git stash push -- src/network/`) : 10 cas sur 13
 * tombent. Les trois qui passent des DEUX cotes sont nommes ici, et ce
 * qu'ils ont appris vaut plus que le compte :
 *
 *   — « le datagramme arrive ENTIER chez le serveur » et « il ouvre UNE
 *     session » passaient AVANT le correctif, et pour une raison qui
 *     n'etait pas prevue : sous une politique PERMISSIVE (`service
 *     "ALL"`), un pare-feu qui ne recolle pas transmet quand meme les
 *     trois fragments, et c'est le SERVEUR qui les recolle avec son
 *     propre reassembleur. Le defaut ne se voit donc pas du tout par la
 *     delivrance ; c'est le cas voisin — la politique qui ne nomme QUE
 *     le port 5000 — qui le montre, parce que les fragments 2 et 3 ne
 *     portent pas ce port et sont refuses un par un.
 *   — le TEMOIN de refus passe des deux cotes par construction : c'est
 *     son role de montrer qu'une regle `deny` bloque dans les deux
 *     etats du produit.
 *
 * Les quatre cas du second bloc tombent eux aussi, mais pour une raison
 * qui ne prouve rien du contrat : `git stash` retire aussi les exports
 * ajoutes au socle (`fragmentKey`, `isIPv4Fragment`, `forget`), donc le
 * module ne se construit meme pas. Ils decrivent le contrat de la table,
 * pas son branchement.
 */

import { describe, it, expect } from 'vitest';
import { FortiGate } from '@/network/devices/firewall/vendors/fortios/FortiGate';
import { FortiShell } from '@/network/devices/firewall/vendors/fortios/FortiShell';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { Cable } from '@/network/hardware/Cable';
import { fragmentIPv4 } from '@/network/core/Ipv4Fragmentation';
import {
  FragmentReassembly, REASSEMBLY_TIMEOUT_MS,
} from '@/network/devices/firewall/l3/FragmentReassembly';
import type { IPv4Packet } from '@/network/core/types';
import { resetCounters, MACAddress, IPAddress } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';

const CLIENT = '203.0.113.10';
const SERVEUR = '192.168.1.10';
const PORT_SERVICE = 5000;
const PETIT_MTU = 600;
const GROS = 1400;
const EN_TETE_UDP = 8;

interface Cmd { executeCommand(cmd: string): Promise<string> }

const runOn = (d: Cmd, cmds: string[]) =>
  cmds.reduce(async (p, c) => { await p; await d.executeCommand(c); },
    Promise.resolve<unknown>(undefined));

function run(sh: FortiShell, ...lines: string[]): string {
  let last = '';
  for (const line of lines) last = sh.execute(line);
  return last;
}

async function laboratoire() {
  resetCounters(); resetDeviceCounters(); MACAddress.resetCounter(); Logger.reset();

  const fw = new FortiGate('firewall-fortinet', 'FGT', 0, 0);
  const sh = fw.getShell();
  const r1 = new CiscoRouter('R1');
  const client = new LinuxPC('linux-pc', 'PC', 300, 0);
  const serveur = new LinuxServer('linux-server', 'SRV', -300, 0);
  for (const d of [r1, client, serveur]) d.powerOn();

  new Cable('c1').connect(client.getPorts()[0], r1.getPort('GigabitEthernet0/0')!);
  new Cable('c2').connect(r1.getPort('GigabitEthernet0/1')!, fw.getPort('port2')!);
  new Cable('c3').connect(fw.getPort('port1')!, serveur.getPorts()[0]);

  await runOn(r1, [
    'enable', 'configure terminal',
    'interface GigabitEthernet0/0',
    'ip address 203.0.113.1 255.255.255.0', 'no shutdown', 'exit',
    'interface GigabitEthernet0/1',
    'ip address 198.51.100.1 255.255.255.0',
    `ip mtu ${PETIT_MTU}`, 'no shutdown', 'exit',
    'ip route 192.168.1.0 255.255.255.0 198.51.100.2',
    'end']);

  run(sh,
    'config system interface',
    'edit "port1"', 'set mode static',
    'set ip 192.168.1.1 255.255.255.0', 'set allowaccess ping', 'next',
    'edit "port2"', 'set mode static',
    'set ip 198.51.100.2 255.255.255.0', 'set allowaccess ping', 'next', 'end',
    'config router static', 'edit 1',
    'set dst 203.0.113.0 255.255.255.0',
    'set gateway 198.51.100.1', 'set device "port2"', 'next', 'end');

  await runOn(client, ['ip link set eth0 up', `ip addr add ${CLIENT}/24 dev eth0`,
    'ip route add default via 203.0.113.1']);
  await runOn(serveur, ['ip link set eth0 up', `ip addr add ${SERVEUR}/24 dev eth0`,
    'ip route add default via 192.168.1.1']);

  return { fw, sh, r1, client, serveur };
}

function politique(sh: FortiShell, service = 'ALL'): string {
  return run(sh,
    'config firewall policy', 'edit 1',
    'set srcintf "port2"', 'set dstintf "port1"',
    'set srcaddr "all"', 'set dstaddr "all"',
    'set action accept', 'set schedule "always"', `set service "${service}"`,
    'next', 'end');
}

/** Ce que le serveur a REELLEMENT recu, taille declaree comprise. */
function ecoute(serveur: LinuxServer): { octets: number[] } {
  const recu = { octets: [] as number[] };
  serveur.udpBind(PORT_SERVICE, ({ udp }) => {
    recu.octets.push(udp.length ?? 0);
  });
  return recu;
}

/**
 * `df: false` est indispensable et n'est pas un detail de sonde : ce
 * simulateur pose DF sur tout UDP sortant, comme une pile moderne qui
 * decouvre le MTU du chemin. Avec DF, le routeur intercale ne fragmente
 * PAS — il rend un ICMP « Fragmentation Needed » et jette le datagramme,
 * ce qui est le comportement juste et ne fait rien arriver au pare-feu.
 */
function envoyer(client: LinuxPC, octets: number): boolean {
  return client.sendUdpDatagram(
    new IPAddress(SERVEUR), PORT_SERVICE, 41000, 'charge', octets, { df: false });
}

describe('phase 21 — un datagramme fragmente est recolle', () => {
  it('le datagramme arrive ENTIER chez le serveur', async () => {
    const { sh, client, serveur } = await laboratoire();
    politique(sh);
    const recu = ecoute(serveur);

    envoyer(client, GROS);

    expect(recu.octets.length).toBe(1);
    expect(recu.octets[0]).toBe(GROS + EN_TETE_UDP);
  });

  it('il ouvre UNE session, pas une par fragment', async () => {
    const { fw, sh, client, serveur } = await laboratoire();
    politique(sh);
    const recu = ecoute(serveur);

    envoyer(client, GROS);

    expect(recu.octets.length).toBe(1);
    const sessions = fw.getSessionTable().view()
      .find(s => s.c2s.destPort === PORT_SERVICE);
    expect(sessions.length).toBe(1);
  });

  it('la politique s applique au datagramme RECOLLE, donc au port qu il porte',
    async () => {
      const { sh, client, serveur } = await laboratoire();
      run(sh,
        'config firewall service custom', 'edit "UDP-5000"',
        'set protocol UDP', 'set udp-portrange 5000', 'next', 'end');
      politique(sh, 'UDP-5000');
      const recu = ecoute(serveur);

      envoyer(client, GROS);

      expect(recu.octets.length).toBe(1);
    });

  it('TEMOIN : une regle qui refuse ce port refuse aussi le fragmente',
    async () => {
      const { sh, client, serveur } = await laboratoire();
      run(sh,
        'config firewall service custom', 'edit "UDP-5000"',
        'set protocol UDP', 'set udp-portrange 5000', 'next', 'end');
      politique(sh, 'UDP-5000');
      run(sh,
        'config firewall policy', 'edit 1', 'set action deny', 'next', 'end');
      const recu = ecoute(serveur);

      envoyer(client, GROS);

      expect(recu.octets.length).toBe(0);
    });

  it('`set ip-fragment-mem-thresholds` vaut 32 par defaut et se regle',
    async () => {
      const { sh } = await laboratoire();

      expect(run(sh, 'show full-configuration system settings'))
        .toContain('set ip-fragment-mem-thresholds 32');

      expect(run(sh,
        'config system settings',
        'set ip-fragment-mem-thresholds 256', 'end')).not.toContain('error');
      expect(run(sh, 'show system settings'))
        .toContain('set ip-fragment-mem-thresholds 256');
    });

  it('une valeur hors bornes est refusee', async () => {
    const { sh } = await laboratoire();

    run(sh, 'config system settings');
    expect(run(sh, 'set ip-fragment-mem-thresholds 16')).toMatch(/value parse error|range/i);
    expect(run(sh, 'set ip-fragment-mem-thresholds 4096')).toMatch(/value parse error|range/i);
    run(sh, 'end');

    expect(run(sh, 'show full-configuration system settings'))
      .toContain('set ip-fragment-mem-thresholds 32');
  });

  it('`diagnose snmp ip frags` rend les compteurs de la MIB IP',
    async () => {
      const { sh } = await laboratoire();

      const vue = run(sh, 'diagnose snmp ip frags');
      expect(vue).toContain('ReasmTimeout');
      expect(vue).toContain('ReasmReqds');
      expect(vue).toContain('ReasmOKs');
      expect(vue).toContain('ReasmFails');
    });

  it('les compteurs MESURENT un recollage reussi', async () => {
    const { sh, client } = await laboratoire();
    politique(sh);

    envoyer(client, GROS);

    const vue = run(sh, 'diagnose snmp ip frags');
    expect(vue).toMatch(/ReasmReqds\s+[1-9]/);
    expect(vue).toMatch(/ReasmOKs\s+[1-9]/);
  });

  it('TEMOIN : un datagramme NON fragmente ne touche pas le reassembleur',
    async () => {
      const { sh, client, serveur } = await laboratoire();
      politique(sh);
      const recu = ecoute(serveur);

      envoyer(client, 100);

      expect(recu.octets).toEqual([100 + EN_TETE_UDP]);
      const vue = run(sh, 'diagnose snmp ip frags');
      expect(vue).toMatch(/ReasmReqds\s+0/);
      expect(vue).toMatch(/ReasmOKs\s+0/);
    });

});

/**
 * Les deux cas qui suivent portent sur le MODULE et non sur la topologie,
 * et c'est ecrit ici plutot que laisse a decouvrir.
 *
 * Un jeu de fragments incomplet ne se produit pas depuis une maquette :
 * la livraison de trames est SYNCHRONE, donc les fragments d'un meme
 * datagramme traversent tous dans le meme appel, et les deux leviers
 * reels qui pourraient en perdre un — la perte et la corruption d'un
 * cable — sont PROBABILISTES, donc incapables de designer LEQUEL. Un
 * levier « jette le n-ieme fragment » n'existe sur aucun equipement et
 * l'inventer serait la porte derobee que ce depot refuse.
 *
 * Ils sont donc nourris avec la sortie de `fragmentIPv4` — la VRAIE
 * fragmentation, celle que le routeur de la maquette applique — dont on
 * retire un fragment. Et ils passent des DEUX cotes de `git stash`, le
 * module etant neuf : ils decrivent le contrat, ils ne prouvent pas le
 * branchement, que les cas de maquette ci-dessus prouvent.
 */
describe('phase 21 — la table de recollage, module seul', () => {
  const datagramme = (identification: number): IPv4Packet => ({
    type: 'ipv4', version: 4, ihl: 5, dscp: 0, ecn: 0, tos: 0,
    totalLength: 20 + GROS, identification,
    flags: 0, fragmentOffset: 0, ttl: 64, protocol: 17, headerChecksum: 0,
    sourceIP: new IPAddress(CLIENT), destinationIP: new IPAddress(SERVEUR),
    payload: { type: 'udp', sourcePort: 41000, destinationPort: PORT_SERVICE,
      length: GROS, checksum: 0, payload: 'charge' },
  } as unknown as IPv4Packet);

  it('un jeu INCOMPLET ne rend rien, et son expiration se compte', () => {
    const table = new FragmentReassembly();
    const fragments = fragmentIPv4(datagramme(1), PETIT_MTU);
    expect(fragments.length).toBeGreaterThan(1);

    for (const fragment of fragments.slice(0, -1)) {
      expect(table.accept(fragment, 0)).toBeNull();
    }

    table.accept(datagramme(2), REASSEMBLY_TIMEOUT_MS + 1);

    expect(table.counters().reasmReqds).toBeGreaterThan(0);
    expect(table.counters().reasmOKs).toBe(0);
    expect(table.counters().reasmFails).toBeGreaterThan(0);
    expect(table.counters().reasmTimeout).toBe(REASSEMBLY_TIMEOUT_MS / 1000);
  });

  /**
   * Le seuil est pose SOUS le minimum que la CLI accepte : la borne de la
   * commande est 32 M, et remplir 32 M de fragments demanderait vingt-cinq
   * mille datagrammes — un test de quinze secondes qui n'apprendrait rien
   * de plus que celui-ci. Le module, lui, n'a pas a connaitre les bornes
   * de la commande ; c'est le schema qui les fait respecter, et le cas de
   * la sonde qui refuse `16` le verifie.
   */
  it('la borne memoire BORNE vraiment', () => {
    const table = new FragmentReassembly();
    const seuilOctets = 4 * (20 + GROS);
    table.setThresholdMegabytes(seuilOctets / (1024 * 1024));

    for (let id = 1; id <= 12; id++) {
      table.accept(fragmentIPv4(datagramme(id), PETIT_MTU)[0], id);
    }

    expect(table.counters().reasmFails).toBeGreaterThan(0);
    expect(table.bytesHeld()).toBeLessThanOrEqual(seuilOctets);
  });

  it('le seuil evince le PLUS ANCIEN jeu, pas celui qui arrive', () => {
    const table = new FragmentReassembly();
    const fragments = fragmentIPv4(datagramme(1), PETIT_MTU);
    table.setThresholdMegabytes((2 * fragments[0].totalLength) / (1024 * 1024));

    table.accept(fragments[0], 1);
    table.accept(fragmentIPv4(datagramme(2), PETIT_MTU)[0], 2);
    table.accept(fragmentIPv4(datagramme(3), PETIT_MTU)[0], 3);

    expect(table.accept(fragments[1], 4)).toBeNull();
    expect(table.counters().reasmOKs).toBe(0);
  });

  it('un datagramme NON fragmente traverse sans rien retenir', () => {
    const table = new FragmentReassembly();
    const entier = datagramme(9);

    expect(table.accept(entier, 0)).toBe(entier);
    expect(table.counters().reasmReqds).toBe(0);
    expect(table.bytesHeld()).toBe(0);
  });
});
