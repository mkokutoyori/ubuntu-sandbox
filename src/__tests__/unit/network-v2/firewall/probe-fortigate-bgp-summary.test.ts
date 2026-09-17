/**
 * `get router info bgp summary' annoncait ZERO prefixe recu, quoi qu'un
 * voisin annonce, et posait ses colonnes ailleurs que la reference.
 *
 * MESURE DE DEPART sur `0b4f943f', un pair eBGP etabli qui nous annonce
 * une route :
 *
 *   Neighbor        V         AS MsgRcvd MsgSent   TblVer  InQ OutQ  Up/Down State/PfxRcd
 *   192.168.100.1   4      65001       0       0        0    0    0 00:00:01            0
 *
 * `prefixesReceived: 0' etait ecrit tel quel dans `summaryFacts()'. Le
 * moteur tient pourtant un `adjRibIn' par pair — les routes apprises de
 * CE voisin, indexees par prefixe — donc la valeur existait et seule la
 * vue l'ignorait. C'est la colonne que l'operateur lit en premier pour
 * savoir si une session sert a quelque chose.
 *
 * AUTORITE pour la mise en page : la sortie CAPTUREE que `ntc-templates'
 * conserve pour `fortinet_get_router_info_bgp_summary'. Quatre lignes de
 * donnees, et elles ne s'alignent PAS entre elles :
 *
 *   10.204.35.84   4      65302   43173   43182  ...  09w3d01h Active
 *   169.132.250.17  4       4224       0       0  ...     never Idle
 *
 * LE CHAMP DU VOISIN N'EST PAS DE LARGEUR FIXE, et c'est mesure sur les
 * quatre lignes : un nom de 12 caracteres amene le `4' a la colonne 15,
 * un nom de 14 l'amene a la 16, et tout le reste de la ligne suit ce
 * decalage. Un champ fixe de 15 ou de 16 alignerait les deux ; c'est donc
 * un `%-13s' suivi de deux blancs, la seule forme qui rende les deux cas.
 * Nous ecrivions un champ fixe de 16, donc un nom court poussait sa ligne
 * d'une colonne trop loin.
 *
 * LA DERNIERE COLONNE CHANGE D'ALIGNEMENT SELON SON CONTENU. Un pair
 * etabli y porte son compte de prefixes, cale a DROITE ; un pair qui ne
 * l'est pas y porte le nom de son etat, cale a GAUCHE — `Idle' commence a
 * la colonne 73 quand `1' finit a la 79. Nous calions tout a droite, si
 * bien qu'un `Idle' partait a la colonne 84 sur un pare-feu ou aucune
 * session ne monte, c'est-a-dire le cas le plus frequent en laboratoire.
 *
 * CE QUE CE LOT NE REND TOUJOURS PAS, mesure et dit plutot que laisse a
 * decouvrir. La capture porte trois lignes de plus entre l'identifiant et
 * le tableau :
 *
 *   BGP table version is 13
 *   1 BGP AS-PATH entries
 *   0 BGP community entries
 *
 * Les deux dernieres sont derivables du Loc-RIB que le moteur calcule
 * deja — les chemins d'AS distincts, et zero communaute puisque
 * `BgpRibEntry' n'en porte aucune. La premiere demande un compteur de
 * VERSION que ce moteur n'a pas : la fabriquer depuis un nombre d'appels
 * a `computeLocRib' donnerait un nombre qui ne veut rien dire. Rendre deux
 * lignes d'un bloc de trois serait plus trompeur que de n'en rendre
 * aucune ; le bloc entier est un lot a soi.
 *
 * `Up/Down' reste dans l'en-tete a la colonne 65 la ou la capture le pose
 * a la 64. La vraie boite ecrit son en-tete a la main — le `static char
 * header[]' que Quagga porte encore aujourd'hui — et son blanc avant
 * `State/PfxRcd' vaut DEUX dans l'en-tete et UN dans les donnees.
 * `TextTable' tire l'en-tete et les donnees d'un seul calcul par colonne :
 * on peut honorer l'une des deux positions, pas les deux. La colonne
 * `State/PfxRcd' est choisie, parce que c'est celle qu'on lit.
 *
 * MESURE : 4 cas tombent sur 8.
 * Les 4 qui passent des deux cotes sont nommes, et ce sont des gardes
 * plutot que des preuves :
 *   - TEMOIN : la session eBGP monte vraiment et le voisin parait. Sans
 *     lui, « la colonne est fausse » et « aucune session n'existe »
 *     seraient indiscernables ;
 *   - le voisin de QUATORZE caracteres posait deja son `4' a la colonne
 *     16, parce qu'un nom de 14 remplit presque le champ fixe de 16 que
 *     nous ecrivions. C'est le nom COURT qui discrimine, et c'est lui qui
 *     tombe : les deux cas ne valent qu'ensemble ;
 *   - l'en-tete posait deja `State/PfxRcd' a la colonne 73 et `V' a la
 *     16. Le lot ne devait pas les emporter en changeant les largeurs de
 *     donnees sous eux — c'est exactement ce que `headerWidth' preserve ;
 *   - NON-REGRESSION : l'identifiant et le total restent rendus.
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

const COURT = '10.204.35.84';
const LONG = '169.132.250.17';

async function laboratoire(): Promise<FortiGate> {
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
    'config neighbor',
    'edit 192.168.100.1', 'set remote-as 65001', 'next',
    `edit ${COURT}`, 'set remote-as 65003', 'next',
    `edit ${LONG}`, 'set remote-as 65004', 'next',
    'end', 'end',
  ]);
  return fgt;
}

const resume = (fgt: FortiGate): Promise<string> =>
  fgt.executeCommand('get router info bgp summary').then(String);

function ligne(vue: string, voisin: string): string {
  return vue.split('\n').find(l => l.startsWith(voisin)) ?? '';
}

function colonneDeLaVersion(l: string): number {
  const lu = /^(\S+)(\s+)4 /.exec(l);
  return lu === null ? -1 : lu[1].length + lu[2].length;
}

describe('`get router info bgp summary` compte et pose ses colonnes', () => {
  it('TEMOIN : la session eBGP monte et le voisin parait', async () => {
    const fgt = await laboratoire();
    expect(ligne(await resume(fgt), '192.168.100.1')).toContain('65001');
  }, 30000);

  it('le prefixe annonce par le pair est COMPTE', async () => {
    const fgt = await laboratoire();
    const cellule = ligne(await resume(fgt), '192.168.100.1').slice(63).trim();

    expect(Number(cellule.split(/\s+/).pop())).toBeGreaterThan(0);
  }, 30000);

  it('un voisin de DOUZE caracteres pose son `4` a la colonne 15', async () => {
    const fgt = await laboratoire();
    expect(colonneDeLaVersion(ligne(await resume(fgt), COURT))).toBe(15);
  }, 30000);

  it('un voisin de QUATORZE le pose a la colonne 16', async () => {
    const fgt = await laboratoire();
    expect(colonneDeLaVersion(ligne(await resume(fgt), LONG))).toBe(16);
  }, 30000);

  it('un voisin NON etabli rend son etat cale a GAUCHE', async () => {
    const fgt = await laboratoire();
    const l = ligne(await resume(fgt), LONG);
    const etat = /(Idle|Active|Connect|OpenSent|OpenConfirm)/.exec(l);

    expect(etat).not.toBeNull();
    expect(etat?.index).toBe(73);
  }, 30000);

  it('un voisin etabli rend son compte cale a DROITE', async () => {
    const fgt = await laboratoire();
    const l = ligne(await resume(fgt), '192.168.100.1');

    expect(l.length).toBe(80);
  }, 30000);

  it('l en-tete pose `State/PfxRcd` a la colonne 73', async () => {
    const fgt = await laboratoire();
    const entete = (await resume(fgt)).split('\n')
      .find(l => l.startsWith('Neighbor')) ?? '';

    expect(entete.indexOf('State/PfxRcd')).toBe(73);
    expect(entete.indexOf('V')).toBe(16);
  }, 30000);

  it('NON-REGRESSION : l identifiant et le total restent rendus', async () => {
    const fgt = await laboratoire();
    const vue = await resume(fgt);

    expect(vue).toContain('BGP router identifier 10.255.255.1, local AS number 65002');
    expect(vue).toContain('Total number of neighbors 3');
  }, 30000);
});
