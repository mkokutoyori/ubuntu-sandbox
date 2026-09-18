/**
 * Les compteurs de messages BGP valaient ZERO en dur dans les deux vues,
 * et `get router info bgp neighbors' taisait le routeur d'en face.
 *
 * MESURE DE DEPART sur `b3b2b25a', session eBGP etablie, OPEN et
 * KEEPALIVE echanges sur le fil :
 *
 *   Neighbor        V         AS MsgRcvd MsgSent ...
 *   192.168.100.1   4      65001       0       0 ...
 *
 *   BGP neighbor is 192.168.100.1, remote AS 65001, local AS 65002, external link
 *     BGP state = Established, up for 00:00:01
 *     Local router ID 10.255.255.1
 *
 * `received: '0'' et `sent: '0'' etaient ecrits tels quels dans
 * `renderBgpSummary'. Un lot precedent avait ferme le `prefixesReceived:
 * 0' voisin sans voir ces deux-la, qui sont pourtant la premiere chose
 * qu'on lit quand une session monte puis retombe : « est-ce que ca parle
 * encore ? ».
 *
 * `BgpSession' ne comptait rien, mais sa structure rendait le comptage
 * facile et le reclamait : UN seul point d'entree (`receive'), et SIX
 * appels a `this.transport.send' disperses. Les six deviennent un
 * `emit' prive — c'est la meme fermeture que celle des sept chemins
 * d'origine de `OSPFEngine' au lot du statut OSPF : l'endroit ou compter
 * est celui ou la duplication se refermait.
 *
 * AUTORITE : la sortie CAPTUREE que `ntc-templates' conserve pour
 * `fortinet_get_router_info_bgp_neighbors'.
 *
 *   VRF 0 neighbor table:
 *   BGP neighbor is 10.105.1.254, remote AS 65400, local AS 65400, internal link
 *     BGP version 4, remote router ID 10.105.3.254
 *     BGP state = Established, up for 4d14h28m
 *     ...
 *     Received 1517339 messages, 2 notifications, 0 in queue
 *     Sent 1482858 messages, 6 notifications, 0 in queue
 *
 * CE QUE CE LOT AJOUTE A CETTE VUE, et rien de plus : la ligne qui nomme
 * la table, la ligne de version et de routeur distant — `remoteId' vit
 * dans `ProtocolNeighborView' depuis toujours et cette vue l'ignorait —
 * et les deux lignes de comptage. `0 in queue' n'est pas un remplissage :
 * ce moteur emet de facon synchrone, donc la file est VRAIMENT vide.
 *
 * CE QU'IL N'AJOUTE PAS. La capture porte encore les temps de garde, les
 * capacites negociees, la famille d'adresses et les versions de table.
 * `BgpSession' porte bien un temps de garde et un intervalle de
 * KEEPALIVE, mais la vue les donne CONFIGURES et NEGOCIES sur deux lignes
 * distinctes, et ce moteur ne distingue pas les deux ; les capacites ne
 * sont pas negociees du tout. Les ecrire serait dire qu'une negociation a
 * eu lieu.
 *
 * LE ROUTEUR D'EN FACE ETAIT DEJA LA, ET LA VUE CHERCHAIT AU MAUVAIS
 * ENDROIT. `BgpSession.handleOpen' garde `open.bgpIdentifier' dans
 * `peerRouterId' depuis toujours, et l'expose par `remoteRouterId'. Mais
 * `remoteId' de `ProtocolNeighborView' — le champ qu'on aurait cru fait
 * pour ca — porte tout autre chose ici : `BGPEngine' y ecrit `AS65001',
 * l'AS distant. Lire le routeur distant dans `remoteId' aurait rendu un
 * numero d'AS deguise en identifiant. C'est la session qu'il faut
 * interroger, et c'est ce que fait ce lot.
 *
 * MESURE : 6 cas tombent sur 8.
 * Les 2 qui passent des deux cotes sont nommes :
 *   - TEMOIN : la session est etablie et la vue la nomme. Sans lui,
 *     « les compteurs sont faux » et « aucune session ne monte » seraient
 *     indiscernables, les deux rendant zero ;
 *   - NON-REGRESSION : la premiere ligne du voisin garde sa forme, que ce
 *     lot encadre de lignes nouvelles sans la toucher.
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

async function laboratoire(): Promise<FortiGate> {
  const fgt = new FortiGate('firewall-fortinet', 'FGT-01', 0, 0);
  const r1 = new CiscoRouter('R1-EDGE', 200, 0);
  new Cable('t').connect(fgt.getPort('port1')!, r1.getPort('GigabitEthernet0/1')!);
  await taper(fgt, [
    'config system interface', 'edit port1', 'set mode static',
    'set ip 192.168.100.99 255.255.255.0', 'set allowaccess ping', 'next', 'end',
  ]);
  await taper(r1, ['enable', 'configure terminal',
    'interface GigabitEthernet0/1',
    'ip address 192.168.100.1 255.255.255.0', 'no shutdown', 'exit',
    'router bgp 65001', 'bgp router-id 10.9.9.9',
    'neighbor 192.168.100.99 remote-as 65002', 'end']);
  await taper(fgt, ['config router bgp', 'set as 65002',
    'set router-id 10.255.255.1',
    'config neighbor', 'edit 192.168.100.1', 'set remote-as 65001', 'next', 'end',
    'end']);
  return fgt;
}

const voisins = (fgt: FortiGate): Promise<string> =>
  fgt.executeCommand('get router info bgp neighbors').then(String);

const resume = (fgt: FortiGate): Promise<string> =>
  fgt.executeCommand('get router info bgp summary').then(String);

function compteurs(resumeRendu: string): { rcvd: number; sent: number } {
  const l = resumeRendu.split('\n').find(x => x.startsWith('192.168.100.1')) ?? '';
  const lu = /^\S+\s+4\s+(\d+)\s+(\d+)\s+(\d+)\s/.exec(l);
  return { rcvd: Number(lu?.[2] ?? NaN), sent: Number(lu?.[3] ?? NaN) };
}

describe('les compteurs de messages BGP comptent vraiment', () => {
  it('TEMOIN : la session est etablie et la vue la nomme', async () => {
    const fgt = await laboratoire();
    expect(await voisins(fgt)).toContain('BGP state = Established');
  }, 30000);

  it('`MsgRcvd` du resume n est plus zero', async () => {
    const fgt = await laboratoire();
    expect(compteurs(await resume(fgt)).rcvd).toBeGreaterThan(0);
  }, 30000);

  it('`MsgSent` du resume n est plus zero', async () => {
    const fgt = await laboratoire();
    expect(compteurs(await resume(fgt)).sent).toBeGreaterThan(0);
  }, 30000);

  it('la vue des voisins s ouvre par la table de VRF', async () => {
    const fgt = await laboratoire();
    expect((await voisins(fgt)).split('\n')[0]).toBe('VRF 0 neighbor table:');
  }, 30000);

  it('elle nomme la version et le ROUTEUR D EN FACE', async () => {
    const fgt = await laboratoire();
    expect(await voisins(fgt)).toContain('  BGP version 4, remote router ID 10.9.9.9');
  }, 30000);

  it('elle compte les messages recus et emis, file vide', async () => {
    const fgt = await laboratoire();
    const vue = await voisins(fgt);
    const recus = /Received (\d+) messages, (\d+) notifications, 0 in queue/.exec(vue);
    const emis = /Sent (\d+) messages, (\d+) notifications, 0 in queue/.exec(vue);

    expect(recus).not.toBeNull();
    expect(emis).not.toBeNull();
    expect(Number(recus?.[1])).toBeGreaterThan(0);
    expect(Number(emis?.[1])).toBeGreaterThan(0);
  }, 30000);

  it('les deux vues comptent la MEME chose', async () => {
    const fgt = await laboratoire();
    const { rcvd, sent } = compteurs(await resume(fgt));
    const vue = await voisins(fgt);

    expect(vue).toContain(`Received ${rcvd} messages`);
    expect(vue).toContain(`Sent ${sent} messages`);
  }, 30000);

  it('NON-REGRESSION : la premiere ligne du voisin garde sa forme', async () => {
    const fgt = await laboratoire();
    expect(await voisins(fgt)).toContain(
      'BGP neighbor is 192.168.100.1, remote AS 65001, local AS 65002, external link');
  }, 30000);
});
