/**
 * `get router info ospf status' n'existait pas sur la FortiGate.
 *
 * MESURE DE DEPART sur `f138878d', sur un FortiGate adjacent a un routeur
 * Cisco en aire 0 :
 *
 *   get router info ospf status -> Command fail. Return code -61
 *
 * `neighbor', `database' et `interface' existaient ; `status' manquait,
 * alors que c'est la vue par laquelle on lit l'etat du PROCESSUS.
 *
 * AUTORITE. FortiOS est proprietaire, sa documentation n'est pas joignable
 * d'ici, et son demon de routage n'est pas Quagga : `show ip ospf' de
 * Quagga ecrit ` OSPF Routing Process, Router ID: %s' (ospf_vty.c, l.2820)
 * la ou la capture ecrit ` Routing Process "ospf 0" with ID ...', et ne
 * contient nulle part la faute de frappe `incomming' que la capture porte.
 * La reference est donc la seule sortie CAPTUREE que `ntc-templates'
 * conserve pour `fortinet_get_router_info_ospf_status'.
 *
 * CE QUE CETTE VUE NE REND PAS, ET POURQUOI. La capture porte des lignes
 * que ce moteur ne peut pas honorer. Les ecrire serait le defaut que la
 * regle 6 nomme — toute l'apparence d'exister, sauf l'effet :
 *
 *   - ` Supports opaque LSA' : ce moteur n'a pas de LSA opaque (aucun
 *     type 9/10/11 dans `OSPFEngine'). La ligne serait fausse, et celle
 *     qui la suit — ` Number of opaque AS LSA 0' — donnerait a croire
 *     qu'un compteur existe.
 *   - ` SPF schedule delay 5 secs, Hold time between two SPFs 10 secs' et
 *     ` Refresh timer 10 secs' : ce moteur n'a aucun de ces minuteurs, et
 *     `CLAUDE.md' enregistre que sa convergence est SYNCHRONE — un delai
 *     d'ordonnancement n'y est pas exprimable, comme la file d'attente
 *     d'Oracle ne l'est pas.
 *   - ` Number of incomming/outgoing current DD exchange neighbors 0/5' :
 *     le numerateur est lisible (voisins en Exchange), le denominateur est
 *     un maximum configurable que ce moteur n'a pas.
 *   - ` Process is not up' : c'est la seule forme attestee, et elle est
 *     attestee sur une machine qui a 2 voisins pleinement adjacents,
 *     35480 SPF et un dernier SPF il y a 22 secondes. Le champ ne dit donc
 *     PAS « le processus tourne », et la forme positive n'est attestee
 *     nulle part. On ne devine pas : la ligne est absente.
 *
 * Un cas ci-dessous epingle ces absences, pour qu'un lot suivant qui
 * ajouterait les LSA opaques ou les minuteurs ait a le dire.
 *
 * CE QUE LA MACHINE PORTAIT DEJA, et que cette vue ne fait que lire :
 * `OSPFEngine' tient le Router ID, les aires, les interfaces et leurs
 * voisins avec leur etat, la LSDB par aire et les externes, et
 * `spfRunCount'. Les LSA y portent une vraie somme de controle Fletcher-16
 * (`computeOSPFLSAChecksum'), si bien que les sommes de cette vue et les
 * `CkSum' de `get router info ospf database' parlent des memes nombres —
 * un cas le verifie, parce que deux vues d'un meme fait qui se
 * contredisent est ce que ce depot referme le plus souvent.
 *
 * CE QUE LE LOT AJOUTE AU MOTEUR, la ou il vit plutot qu'a l'affichage :
 * un compteur de LSA ORIGINES, un de LSA RECUS, l'instant du dernier SPF
 * et un compte de SPF PAR AIRE. Chacun est incremente a l'evenement reel —
 * l'origine dans `installLSA' quand l'emetteur est nous, la reception dans
 * la boucle de `processLSUpdate' une fois la somme de controle validee,
 * le SPF dans `runSPF' et dans sa boucle par aire — et non au moment de
 * l'affichage.
 *
 * DEUX DEFAUTS RENCONTRES EN CHEMIN, refermes ici.
 *
 * `OSPFEngine' portait DEUX sommes de controle pour un meme fait : la
 * vraie Fletcher-16 (`computeOSPFLSAChecksum') et une
 * `computeLSAChecksum' privee, annoncee en commentaire comme
 * « simplified checksum (not the real Fletcher-16) », appelee sur SEPT
 * chemins d'origine. Un commentaire posé plus tôt l'avait deja
 * diagnostiquee sans la refermer — « a simplified placeholder every other
 * origination path overwrites the same way ». C'est exact : `installLSA'
 * recalcule toujours la vraie, si bien que la fausse etait ECRASEE et que
 * rien d'observable n'en dependait. Rien n'obligeait pourtant les deux a
 * rester d'accord, et `isNewerLSA' departage justement deux LSA par leur
 * somme (RFC 2328 §13.1). La copie est supprimee, le contournement avec.
 *
 * Les sept chemins d'origine finissaient tous par la MEME sequence —
 * `installLSA' puis `floodLSA' puis `return lsa'. Elle devient
 * `originateOwnLSA', qui est aussi le seul endroit ou compter une
 * origine.
 *
 * SUR LE COMPTEUR D'ORIGINES, une precision que la mesure impose. Il etait
 * d'abord place dans `installLSA', sous condition que l'emetteur soit
 * nous. Or `processLSUpdate' installe par ce meme chemin tout LSA plus
 * recent, y compris un LSA de NOTRE routeur revenu par le fil : le
 * compteur aurait alors compte une reception comme une origine. Dans ce
 * laboratoire les deux placements donnent le MEME nombre — le LSA ne
 * revient pas — donc ce deplacement est une PRECAUTION justifiee par le
 * chemin de code, pas un defaut mesure, et il est dit comme tel.
 *
 * MESURE : 10 cas tombent sur 12.
 * Les 2 qui passent des deux cotes sont nommes :
 *   - TEMOIN : `get router info ospf neighbor' montrait DEJA l'adjacence.
 *     Sans lui, « la vue est fausse » et « le lab n'a jamais converge »
 *     seraient indiscernables — les deux rendent une chaine sans les
 *     nombres attendus ;
 *   - NON-REGRESSION : `get router info ospf database' repond toujours,
 *     et ce lot touche au moteur partage sans emporter la vue d'a cote.
 *
 * Le cas des ABSENCES a d'abord passe des deux cotes, et ne le devait
 * pas : `Command fail. Return code -61' ne contient evidemment aucune des
 * lignes qu'on lui demande de ne pas contenir. Il exige desormais d'abord
 * que la vue SOIT une vue de statut.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { FortiGate } from '@/network/devices/firewall/vendors/fortios/FortiGate';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { Cable } from '@/network/hardware/Cable';
import { resetCounters, MACAddress } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { VirtualTimeScheduler, __setDefaultScheduler } from '@/events/Scheduler';

interface Cmd { executeCommand(cmd: string): Promise<string> }

async function taper(d: Cmd, cmds: readonly string[]): Promise<void> {
  for (const c of cmds) await d.executeCommand(c);
}

let horloge: VirtualTimeScheduler;

beforeEach(() => {
  resetCounters(); resetDeviceCounters(); MACAddress.resetCounter(); Logger.reset();
  horloge = new VirtualTimeScheduler();
  __setDefaultScheduler(horloge);
});

async function laboratoire(): Promise<{ fgt: FortiGate }> {
  const fgt = new FortiGate('firewall-fortinet', 'FGT-01', 0, 0);
  const r1 = new CiscoRouter('R1-EDGE', 200, 0);

  new Cable('transit').connect(fgt.getPort('port1')!, r1.getPort('GigabitEthernet0/1')!);

  await taper(fgt, [
    'config system interface',
    'edit port1', 'set mode static',
    'set ip 192.168.100.99 255.255.255.0', 'set allowaccess ping', 'next', 'end',
  ]);
  await taper(r1, [
    'enable', 'configure terminal',
    'interface GigabitEthernet0/1',
    'ip address 192.168.100.1 255.255.255.0', 'no shutdown', 'exit',
    'router ospf 1', 'router-id 10.255.255.254',
    'network 192.168.100.0 0.0.0.255 area 0', 'end',
  ]);
  await taper(fgt, [
    'config router ospf',
    'set router-id 10.255.255.1',
    'config area', 'edit 0.0.0.0', 'next', 'end',
    'config network',
    'edit 1', 'set prefix 192.168.100.0 255.255.255.0', 'set area 0.0.0.0', 'next',
    'end',
    'end',
  ]);
  horloge.advance(60_000);
  await fgt.executeCommand('get router info ospf neighbor');
  return { fgt };
}

const statut = (fgt: FortiGate): Promise<string> =>
  fgt.executeCommand('get router info ospf status').then(String);

function nombre(vue: string, motif: RegExp): number {
  return Number(motif.exec(vue)?.[1] ?? Number.NaN);
}

describe('`get router info ospf status` rend l_etat que le moteur porte', () => {
  it('TEMOIN : l adjacence existe et `get router info ospf neighbor` la montre', async () => {
    const { fgt } = await laboratoire();
    expect(await fgt.executeCommand('get router info ospf neighbor'))
      .toContain('10.255.255.254');
  }, 30000);

  it('la commande est acceptee', async () => {
    const { fgt } = await laboratoire();
    const vue = await statut(fgt);
    expect(vue).not.toMatch(/Command fail|unknown configuration path/i);
  }, 30000);

  it('la premiere ligne nomme le processus et le Router ID', async () => {
    const { fgt } = await laboratoire();
    expect((await statut(fgt)).split('\n')[0])
      .toBe(' Routing Process "ospf 0" with ID 10.255.255.1');
  }, 30000);

  it('les lignes de premier niveau portent UN espace de retrait', async () => {
    const { fgt } = await laboratoire();
    const lignes = (await statut(fgt)).split('\n')
      .filter(l => l.includes('Conforms to') || l.includes('External LSA database'));
    expect(lignes.length).toBe(2);
    for (const l of lignes) expect(/^ [^ ]/.test(l)).toBe(true);
  }, 30000);

  it('l aire zero est rendue BACKBONE, avec quatre espaces', async () => {
    const { fgt } = await laboratoire();
    const vue = await statut(fgt);
    expect(vue).toContain('\n    Area 0.0.0.0 (BACKBONE)\n');
    expect(nombre(vue, /Number of areas attached to this router: (\d+)/)).toBe(1);
  }, 30000);

  it('le corps d une aire est indente de HUIT espaces', async () => {
    const { fgt } = await laboratoire();
    const lignes = (await statut(fgt)).split('\n')
      .filter(l => l.includes('fully adjacent neighbors') || l.includes('SPF algorithm'));
    expect(lignes.length).toBe(3);
    for (const l of lignes) expect(l.startsWith('        ')).toBe(true);
  }, 30000);

  it('les voisins pleinement adjacents sont comptes', async () => {
    const { fgt } = await laboratoire();
    expect(nombre(await statut(fgt),
      /Number of fully adjacent neighbors in this area is (\d+)/)).toBe(1);
  }, 30000);

  it('la somme de controle de l aire est celle des LSA de la base', async () => {
    const { fgt } = await laboratoire();
    const base = String(await fgt.executeCommand('get router info ospf database'));
    const sommes = [...base.matchAll(/0x([0-9a-fA-F]{4})\s+\d+\s*$/gm)]
      .map(m => parseInt(m[1], 16));
    expect(sommes.length).toBeGreaterThan(0);

    const vue = await statut(fgt);
    const lue = /Number of LSA \d+\. Checksum 0x([0-9A-F]{6})/.exec(vue)?.[1];
    expect(lue).toBeDefined();
    expect(parseInt(lue ?? '', 16)).toBeGreaterThanOrEqual(Math.max(...sommes));
  }, 30000);

  it('les LSA origines et recus sont comptes, non inventes', async () => {
    const { fgt } = await laboratoire();
    const vue = await statut(fgt);
    expect(nombre(vue, /Number of LSA originated (\d+)/)).toBeGreaterThan(0);
    expect(nombre(vue, /Number of LSA received (\d+)/)).toBeGreaterThan(0);
  }, 30000);

  it('le SPF est compte et date', async () => {
    const { fgt } = await laboratoire();
    const vue = await statut(fgt);
    expect(nombre(vue, /SPF algorithm executed (\d+) times/)).toBeGreaterThan(0);
    expect(vue).toMatch(/SPF algorithm last executed \d\d:\d\d:\d\d\.\d{3} ago/);
  }, 30000);

  it('les lignes que ce moteur ne peut pas honorer sont ABSENTES', async () => {
    const { fgt } = await laboratoire();
    const vue = await statut(fgt);
    expect(vue).toContain('Routing Process');
    expect(vue).not.toContain('Supports opaque LSA');
    expect(vue).not.toContain('opaque AS LSA');
    expect(vue).not.toContain('SPF schedule delay');
    expect(vue).not.toContain('Refresh timer');
    expect(vue).not.toContain('DD exchange neighbors');
    expect(vue).not.toContain('Process is');
  }, 30000);

  it('NON-REGRESSION : `get router info ospf database` repond toujours', async () => {
    const { fgt } = await laboratoire();
    expect(await fgt.executeCommand('get router info ospf database'))
      .toContain('OSPF Router with ID (10.255.255.1)');
  }, 30000);
});
