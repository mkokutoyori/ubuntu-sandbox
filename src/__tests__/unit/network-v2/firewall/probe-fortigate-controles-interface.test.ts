/**
 * `src-check', `drop-fragment' et `drop-overlapped-fragment' n'existaient
 * pas : la CLI les refusait et rien ne les evaluait.
 *
 * MESURE DE DEPART sur `718c6a11' :
 *
 *   config system interface / edit port1 / set src-check enable
 *   -> command parse error before 'src-check'
 *
 * Ces trois options sont dans la sortie CAPTUREE de `get system
 * interface' que `ntc-templates' conserve — le lot precedent les avait
 * NOMMEES comme absentes du schema et laissees de cote plutot que rendues
 * a `disable', ce qui aurait donne a croire qu'un interrupteur existait.
 * Celui-ci les declare ET les fait decider.
 *
 * CE QUE `src-check' DECIDE. La capture atteste le champ et sa valeur
 * `enable', pas son algorithme. L'autorite est donc le standard adopte :
 * le controle de chemin inverse unicast, BCP 84 / RFC 3704. Le mode STRICT
 * (§2.1) est celui qui porte le nom de « source check » sur un pare-feu —
 * la route vers la SOURCE doit sortir par l'interface d'ENTREE. Le mode
 * lache (§2.4), qui ne verifie que l'existence d'une route, ne rejetterait
 * presque rien dans ce simulateur ou toute source de laboratoire est
 * joignable : ce serait un critere stocke et a peine evalue. La forme
 * globale que FortiOS ajoute par-dessus n'est pas attestee d'ici et n'est
 * donc pas inventee.
 *
 * OU CHAQUE CONTROLE AGIT, et pourquoi ce n'est pas au meme endroit.
 * `handleIpv4Frame' RECOLLE les fragments AVANT le pipeline : quand une
 * etape s'execute, le datagramme n'est plus un fragment. Les deux
 * controles de fragment sont donc a l'entree, avant `FragmentReassembly',
 * et `src-check' est une ETAPE du pipeline — ce qui lui donne en prime sa
 * ligne dans `diagnose debug flow'. Sa place, apres `dos-policy' et avant
 * la traduction d'adresse, est ce qui la rend juste : le chemin inverse
 * doit se lire sur la source ORIGINALE.
 *
 * VALEURS PAR DEFAUT. `src-check' est `enable', comme la capture le
 * montre ; les deux controles de fragment sont `disable'. Un pare-feu qui
 * ne declare pas ces options — ASA, Palo Alto — n'en herite pas : le
 * lecteur par defaut de `Firewall' repond « aucun controle », et seul
 * FortiOS branche le sien.
 *
 * CE QUE LA MESURE A DIT DU DEFAUT `enable'. Sur les 2995 tests du rayon
 * pare-feu, cinq sont tombes, tous dans la meme sonde SD-WAN, et pour la
 * meme raison : son laboratoire emettait depuis `10.1.0.x' sur un
 * pare-feu dont `port1' porte `10.1.1.1/24' et qui n'a aucune route vers
 * `10.1.0.0/24'. Un vrai FortiGate a `src-check enable' les aurait
 * rejetes aussi. Le laboratoire est corrige pour emettre depuis le sous-
 * reseau connecte, et ses mesures de repartition sont inchangees.
 *
 * MESURE : 9 cas tombent sur 11.
 * Les 2 qui passent des deux cotes sont nommes :
 *   - TEMOIN : un paquet de la source legitime traverse le pare-feu et
 *     ressort par `port1'. Sans lui, « le controle rejette » et « le
 *     laboratoire ne route rien » seraient indiscernables — les deux
 *     comptent zero trame en sortie ;
 *   - NON-REGRESSION : un datagramme ENTIER traverse encore quand
 *     `drop-fragment' est actif. Le controle ne doit faire tomber que ce
 *     qui est fragmente.
 *
 * Trois cas passaient d'abord des deux cotes et ne le devaient pas : ceux
 * qui ETEIGNENT une option et constatent que le trafic passe. Sur
 * `718c6a11' la commande est refusee, donc rien n'est eteint et le trafic
 * passe pour une tout autre raison. Ils exigent desormais d'abord que la
 * commande soit ACCEPTEE.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { FortiGate } from '@/network/devices/firewall/vendors/fortios/FortiGate';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { Cable } from '@/network/hardware/Cable';
import {
  ETHERTYPE_IPV4, IPAddress, IP_PROTO_ICMP, MACAddress, computeIPv4Checksum,
  createIPv4Packet, resetCounters, type EthernetFrame, type IPv4Packet,
} from '@/network/core/types';
import { IPV4_FLAG_MF } from '@/network/core/Ipv4Fragmentation';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';

interface Cmd { executeCommand(cmd: string): Promise<string> }

async function taper(d: Cmd, cmds: readonly string[]): Promise<void> {
  for (const c of cmds) await d.executeCommand(c);
}

beforeEach(() => {
  resetCounters(); resetDeviceCounters(); MACAddress.resetCounter(); Logger.reset();
});

async function laboratoire(): Promise<{ fgt: FortiGate; pc: LinuxPC }> {
  const fgt = new FortiGate('firewall-fortinet', 'FGT-01', 0, 0);
  const pc = new LinuxPC('linux-pc', 'PC', -200, 0);
  const amont = new LinuxPC('linux-pc', 'AMONT', 200, 0);
  new Cable('lan').connect(pc.getPort('eth0')!, fgt.getPort('port2')!);
  new Cable('wan').connect(amont.getPort('eth0')!, fgt.getPort('port1')!);
  await taper(pc, ['ip addr add 192.168.10.5/24 dev eth0', 'ip link set eth0 up']);
  await taper(amont, [
    'ip addr add 192.168.100.1/24 dev eth0', 'ip link set eth0 up']);
  await taper(fgt, [
    'config system interface',
    'edit port1', 'set mode static',
    'set ip 192.168.100.99 255.255.255.0', 'set allowaccess ping', 'next',
    'edit port2', 'set mode static',
    'set ip 192.168.10.1 255.255.255.0', 'set allowaccess ping', 'next', 'end',
    'config router static', 'edit 1',
    'set dst 172.16.0.0 255.255.0.0', 'set gateway 192.168.100.1',
    'set device "port1"', 'next', 'end',
    'config firewall policy', 'edit 1',
    'set srcintf "port2"', 'set dstintf "port1"',
    'set srcaddr "all"', 'set dstaddr "all"',
    'set service "ALL"', 'set action accept', 'next', 'end',
  ]);
  return { fgt, pc };
}

function paquet(source: string, options: Partial<IPv4Packet> = {}): IPv4Packet {
  const base = createIPv4Packet(
    new IPAddress(source), new IPAddress('172.16.9.9'),
    IP_PROTO_ICMP, 64, {}, 64);
  const packet = { ...base, ...options, headerChecksum: 0 };
  return { ...packet, headerChecksum: computeIPv4Checksum(packet) };
}

function trameVers(fgt: FortiGate, packet: IPv4Packet): EthernetFrame {
  return {
    srcMAC: new MACAddress('02:aa:bb:cc:dd:ee'),
    dstMAC: fgt.getPort('port2')!.getMAC(),
    etherType: ETHERTYPE_IPV4,
    payload: packet,
  };
}

function emisesParPort1(fgt: FortiGate, packet: IPv4Packet): number {
  const avant = fgt.getPort('port1')!.getCounters().framesOut;
  fgt.getPort('port2')!.receiveFrame(trameVers(fgt, packet));
  return fgt.getPort('port1')!.getCounters().framesOut - avant;
}

function fragment(id: number, octetDepart: number, more: boolean): IPv4Packet {
  return paquet('192.168.10.5', {
    identification: id, flags: more ? IPV4_FLAG_MF : 0,
    fragmentOffset: octetDepart / 8,
  });
}

async function fragmentsDemandes(fgt: FortiGate): Promise<number> {
  const vue = String(await fgt.executeCommand('diagnose snmp ip frags'));
  return Number(/ReasmReqds\s+(\d+)/.exec(vue)?.[1] ?? Number.NaN);
}

describe('les controles d_interface a l_entree decident vraiment', () => {
  it('TEMOIN : un paquet de la source legitime traverse', async () => {
    const { fgt } = await laboratoire();
    expect(emisesParPort1(fgt, paquet('192.168.10.5'))).toBe(1);
  }, 30000);

  it('`src-check` est rendu, et vaut `enable` par defaut', async () => {
    const { fgt } = await laboratoire();
    expect(await fgt.executeCommand('get system interface'))
      .toContain('src-check: enable');
  }, 30000);

  it('une source dont le chemin inverse sort AILLEURS est rejetee', async () => {
    const { fgt } = await laboratoire();
    expect(emisesParPort1(fgt, paquet('172.16.9.1'))).toBe(0);
  }, 30000);

  it('`set src-check disable` est ACCEPTE, et la laisse passer', async () => {
    const { fgt } = await laboratoire();
    await fgt.executeCommand('config system interface');
    await fgt.executeCommand('edit port2');
    expect(String(await fgt.executeCommand('set src-check disable'))).toBe('');
    await taper(fgt, ['next', 'end']);

    expect(emisesParPort1(fgt, paquet('172.16.9.1'))).toBe(1);
  }, 30000);

  it('une source SANS aucune route est rejetee elle aussi', async () => {
    const { fgt } = await laboratoire();
    expect(emisesParPort1(fgt, paquet('203.0.113.7'))).toBe(0);
  }, 30000);

  it('`drop-fragment` vaut `disable` par defaut, et un fragment est admis', async () => {
    const { fgt } = await laboratoire();
    expect(await fgt.executeCommand('get system interface'))
      .toContain('drop-fragment: disable');

    const avant = await fragmentsDemandes(fgt);
    fgt.getPort('port2')!.receiveFrame(trameVers(fgt, fragment(11, 0, true)));
    expect(await fragmentsDemandes(fgt)).toBe(avant + 1);
  }, 30000);

  it('`set drop-fragment enable` le fait tomber avant le recollage', async () => {
    const { fgt } = await laboratoire();
    await taper(fgt, ['config system interface', 'edit port2',
      'set drop-fragment enable', 'next', 'end']);

    const avant = await fragmentsDemandes(fgt);
    fgt.getPort('port2')!.receiveFrame(trameVers(fgt, fragment(12, 0, true)));
    expect(await fragmentsDemandes(fgt)).toBe(avant);
  }, 30000);

  it('`drop-overlapped-fragment` ne fait tomber que le CHEVAUCHANT', async () => {
    const { fgt } = await laboratoire();
    await taper(fgt, ['config system interface', 'edit port2',
      'set drop-overlapped-fragment enable', 'next', 'end']);

    const avant = await fragmentsDemandes(fgt);
    fgt.getPort('port2')!.receiveFrame(trameVers(fgt, fragment(21, 0, true)));
    fgt.getPort('port2')!.receiveFrame(trameVers(fgt, fragment(21, 32, true)));

    expect(await fragmentsDemandes(fgt)).toBe(avant + 1);
  }, 30000);

  it('le controle est SELECTIF : deux fragments JOINTIFS passent tous deux', async () => {
    const { fgt } = await laboratoire();
    await fgt.executeCommand('config system interface');
    await fgt.executeCommand('edit port2');
    expect(String(await fgt.executeCommand('set drop-overlapped-fragment enable')))
      .toBe('');
    await taper(fgt, ['next', 'end']);

    const avant = await fragmentsDemandes(fgt);
    fgt.getPort('port2')!.receiveFrame(trameVers(fgt, fragment(31, 0, true)));
    fgt.getPort('port2')!.receiveFrame(trameVers(fgt, fragment(31, 64, true)));

    expect(await fragmentsDemandes(fgt)).toBe(avant + 2);
  }, 30000);

  it('la ligne d interface porte les trois champs, dans l ordre de la capture', async () => {
    const { fgt } = await laboratoire();
    expect((await fgt.executeCommand('get system interface')).split('\n'))
      .toContain('name: port2   mode: static    ip: 192.168.10.1 255.255.255.0'
        + '   status: up    type: physical   src-check: enable'
        + '    drop-overlapped-fragment: disable    drop-fragment: disable');
  }, 30000);

  it('NON-REGRESSION : un datagramme ENTIER traverse malgre `drop-fragment`', async () => {
    const { fgt } = await laboratoire();
    await taper(fgt, ['config system interface', 'edit port2',
      'set drop-fragment enable', 'next', 'end']);

    expect(emisesParPort1(fgt, paquet('192.168.10.5'))).toBe(1);
  }, 30000);
});
