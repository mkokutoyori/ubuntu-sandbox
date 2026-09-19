/**
 * `get router info bgp summary' ne rendait pas son bloc de trois lignes,
 * et posait `TblVer' a zero pour tout le monde.
 *
 * Ce lot ferme ce que `probe-fortigate-bgp-summary' avait MESURE et
 * laisse ouvert. La capture reelle
 * `ntc-templates/tests/fortinet/get_router_info_bgp_summary/` porte,
 * entre l'identifiant et le tableau :
 *
 *   BGP table version is 13
 *   1 BGP AS-PATH entries
 *   0 BGP community entries
 *
 * Nous n'en rendions aucune, et la colonne `TblVer` du tableau valait
 * `'0'` ECRIT TEL QUEL pour chaque pair.
 *
 * CE QUE LA CAPTURE TRANCHE, et qu'on ne pouvait pas deviner autrement :
 * la boite capturee est en AS 65302 avec deux pairs iBGP dans le meme AS
 * et deux pairs eBGP en AS 4224 restes `Idle`. Un pair iBGP ne prepend
 * pas, donc toutes les routes de sa table portent un chemin d'AS VIDE --
 * et elle annonce `1 BGP AS-PATH entries`. Le chemin vide compte donc
 * pour UNE entree. La meme table annonce `0 BGP community entries` :
 * une communaute ABSENTE ne compte pas, la ou un chemin vide compte.
 * Les deux lignes ensemble donnent la regle ; ni l'une ni l'autre seule.
 *
 * LA VERSION DE TABLE est un compteur qui avance a chaque changement du
 * Loc-RIB, et `TblVer` d'un pair est la version qu'on lui a envoyee en
 * dernier -- d'ou le `12` d'un pair etabli face au `13` de la table dans
 * la capture, et le `0` des pairs qui n'ont jamais rien recu.
 *
 * L'EN-TETE : `probe-fortigate-bgp-summary` affirmait qu'on ne pouvait
 * pas poser a la fois `Up/Down` et `State/PfxRcd` la ou la capture les
 * pose, `TextTable` tirant l'en-tete et les donnees d'un seul calcul.
 * C'ETAIT FAUX, et cette sonde le mesure : `headerWidth` decouple
 * DEJA chaque colonne d'en-tete de sa colonne de donnees, et deux
 * nombres suffisent (8 pour `Up/Down`, 14 pour `State/PfxRcd`). L'en-tete
 * capture se reproduit alors CARACTERE POUR CARACTERE. L'en-tete de
 * l'autre sonde est corrigee dans le meme lot.
 *
 * Discrimine par `git stash push -- src/network` : 7 cas sur 8 tombent.
 * Le seul qui passe des deux cotes est le TEMOIN, et c'est ce qu'on lui
 * demande : il prouve que la session eBGP monte et qu'une route est
 * apprise, sans quoi un tableau vide ferait passer les absences pour des
 * reussites.
 *
 * DEUX CHOSES MESUREES EN CHEMIN, dites ici plutot que laissees a
 * decouvrir.
 *
 * La premiere est un DEFAUT, et il depasse ce lot : `FirewallBgp.apply`
 * construit un `BGPEngine` NEUF a chaque application de configuration.
 * Un second `config router bgp ... end` jette donc toutes les sessions,
 * et elles ne se retablissent pas -- la table retombe a zero. Les
 * laboratoires de cette sonde declarent pour cette raison leur reseau
 * local dans la MEME application que leurs voisins. Un vrai FortiGate ne
 * reinitialise pas BGP pour un `network` ajoute ; rendre `apply`
 * incremental est un lot a soi.
 *
 * La seconde n'est PAS un defaut et le premier jet de cette sonde s'y
 * est trompe : `set prefix 172.16.0.0 255.255.0.0` n'origine rien,
 * puisque le prefixe n'est pas dans la RIB. C'est la regle de `network`
 * en BGP, et notre moteur l'applique (`originatedPrefixes`). Le
 * laboratoire origine donc le reseau CONNECTE de `port1`.
 *
 * Limite assumee : `BgpRibEntry.communities` est toujours vide parce que
 * `BgpPathAttributes` ne porte pas l'attribut COMMUNITY (RFC 1997). Le
 * vocabulaire CLI existe pourtant (`BGP_WELL_KNOWN_COMMUNITIES`) : c'est
 * un lot a soi, et il n'est pas ouvert ici. Le compte est CALCULE sur la
 * table et non ecrit en dur, si bien que le jour ou l'attribut traverse
 * le fil, la ligne suit.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { FortiGate } from '@/network/devices/firewall/vendors/fortios/FortiGate';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { Cable } from '@/network/hardware/Cable';
import { MACAddress, resetCounters } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';

interface Cmd { executeCommand(cmd: string): Promise<string> }

async function taper(d: Cmd, cmds: readonly string[]): Promise<void> {
  for (const c of cmds) await d.executeCommand(c);
}

beforeEach(() => {
  resetCounters(); resetDeviceCounters(); MACAddress.resetCounter(); Logger.reset();
});

const ENTETE_CAPTUREE =
  'Neighbor        V         AS MsgRcvd MsgSent   TblVer  InQ OutQ Up/Down  State/PfxRcd';

async function laboratoire(reseauLocal = false): Promise<FortiGate> {
  const fgt = new FortiGate('firewall-fortinet', 'FGT-01', 0, 0);
  const r1 = new CiscoRouter('R1-EDGE', 200, 0);
  new Cable('transit').connect(fgt.getPort('port1')!, r1.getPort('GigabitEthernet0/1')!);

  await taper(fgt, [
    'config system interface', 'edit port1', 'set mode static',
    'set ip 192.168.100.99 255.255.255.0', 'set allowaccess ping', 'next', 'end',
  ]);
  await taper(r1, [
    'enable', 'configure terminal',
    'interface Loopback0', 'ip address 10.0.0.1 255.0.0.0', 'exit',
    'interface GigabitEthernet0/1',
    'ip address 192.168.100.1 255.255.255.0', 'no shutdown', 'exit',
    'router bgp 65001', 'bgp router-id 10.255.255.254',
    'neighbor 192.168.100.99 remote-as 65002',
    'network 10.0.0.0 mask 255.0.0.0', 'end',
  ]);
  await taper(fgt, [
    'config router bgp', 'set as 65002', 'set router-id 10.255.255.1',
    'config neighbor', 'edit 192.168.100.1', 'set remote-as 65001', 'next', 'end',
    ...(reseauLocal
      ? ['config network', 'edit 1', 'set prefix 192.168.100.0 255.255.255.0',
        'next', 'end']
      : []),
    'end',
  ]);
  return fgt;
}

async function pareFeuSansTable(): Promise<FortiGate> {
  const fgt = new FortiGate('firewall-fortinet', 'FGT-02', 0, 0);
  await taper(fgt, ['config router bgp', 'set as 65002', 'end']);
  return fgt;
}

const resume = (fgt: FortiGate): Promise<string> =>
  fgt.executeCommand('get router info bgp summary').then(String);

function nombreDe(vue: string, motif: RegExp): number {
  const l = vue.split('\n').find(x => motif.test(x)) ?? '';
  return Number(motif.exec(l)?.[1] ?? NaN);
}

const VERSION = /^BGP table version is (\d+)$/;
const CHEMINS = /^(\d+) BGP AS-PATH entries$/;
const COMMUNAUTES = /^(\d+) BGP community entries$/;

function ligne(vue: string, voisin: string): string {
  return vue.split('\n').find(l => l.startsWith(voisin)) ?? '';
}

describe('`get router info bgp summary` rend son bloc de version de table', () => {
  it('TEMOIN : la session monte et une route est apprise', async () => {
    const vue = await resume(await laboratoire());
    expect(ligne(vue, '192.168.100.1')).toContain('65001');
    expect(Number(ligne(vue, '192.168.100.1').slice(71).trim())).toBeGreaterThan(0);
  }, 30000);

  it('les trois lignes suivent l identifiant, dans l ordre de la capture', async () => {
    const lignes = (await resume(await laboratoire())).split('\n');
    expect(lignes[0]).toMatch(/^BGP router identifier /);
    expect(lignes[1]).toMatch(VERSION);
    expect(lignes[2]).toMatch(CHEMINS);
    expect(lignes[3]).toMatch(COMMUNAUTES);
    expect(lignes[4]).toBe('');
  }, 30000);

  it('la version de table COMPTE les changements, elle n est pas figee', async () => {
    expect(nombreDe(await resume(await pareFeuSansTable()), VERSION)).toBe(0);
    expect(nombreDe(await resume(await laboratoire()), VERSION)).toBeGreaterThan(0);
  }, 30000);

  it('un seul chemin d AS tant qu une seule origine existe', async () => {
    expect(nombreDe(await resume(await laboratoire()), CHEMINS)).toBe(1);
  }, 30000);

  it('un reseau local AJOUTE un chemin d AS, celui qui est VIDE', async () => {
    expect(nombreDe(await resume(await laboratoire(true)), CHEMINS)).toBe(2);
    expect(nombreDe(await resume(await laboratoire(false)), CHEMINS)).toBe(1);
  }, 30000);

  it('zero communaute, et le nombre est COMPTE', async () => {
    expect(nombreDe(await resume(await laboratoire()), COMMUNAUTES)).toBe(0);
  }, 30000);

  it('TblVer d un pair servi n est plus zero', async () => {
    const vue = await resume(await laboratoire(true));
    const cellule = ligne(vue, '192.168.100.1').slice(44, 53).trim();
    expect(Number(cellule)).toBeGreaterThan(0);
  }, 30000);

  it('l en-tete est CELUI de la capture, caractere pour caractere', async () => {
    const entete = (await resume(await laboratoire())).split('\n')
      .find(l => l.startsWith('Neighbor')) ?? '';
    expect(entete).toBe(ENTETE_CAPTUREE);
  }, 30000);
});
