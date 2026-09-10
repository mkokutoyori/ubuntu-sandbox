/*
 * `match mac address` dans une carte d'acces VLAN, et la regle PAR TYPE
 * DE PAQUET qui la gouverne.
 *
 * Suite du lot VACL. Ce n'est pas la correction d'un defaut : la clause
 * n'existait pas, elle etait REFUSEE, et `AUDIT-ACL-VACL.md` §5 le
 * disait. Le commit `0f9e7ebaa` d'un autre agent ayant apporte
 * `switch/MacAccessList.ts`, la brique manquante est devenue un cablage.
 *
 * CE QUI SE JOUE, ET QUI N'EST PAS LA CLAUSE ELLE-MEME. La reference
 * enonce une regle par TYPE de paquet, et non un refus implicite global :
 *
 *   « If there is a match clause for that type of packet (IP or MAC) in
 *     the VLAN map, the default action is to drop the packet if the
 *     packet does not match any of the entries within the map. If there
 *     is no match clause for that type of packet, the default is to
 *     forward the packet. »
 *
 * `vaclPermits` terminait par un `return false` inconditionnel — juste
 * tant que toute carte portait une clause IP ou une entree sans clause,
 * FAUX des qu'une carte ne porte que des clauses MAC : le trafic IP y
 * serait tombe dans un refus qu'aucune clause ne prononce. Les quatre
 * cas sont donc epingles ensemble, parce qu'ils ne se separent pas.
 *
 * DISCRIMINATION (`git stash` des trois fichiers) : 5 des 6 cas
 * tombent. Le seul qui passe des deux cotes est nomme plutot que laisse
 * a decouvrir — « une trame non-IP est transmise quand la carte ne porte
 * AUCUNE clause MAC » : c'est le TEMOIN, deja juste avant, et il doit le
 * rester, sans quoi ce lot aurait ferme un chemin qui devait rester
 * ouvert.
 *
 * UN CAS A CHANGE DE CAMP, ET C'EST MA SONDE QUI ETAIT FAUSSE. « une
 * carte ne portant que des clauses MAC transmet l'IP » passait d'abord
 * des DEUX cotes, ce qui aurait fait croire a un comportement deja
 * juste. Il ne l'etait pas : l'assertion s'ecrivait
 * `toContain('0% packet loss')`, et « 100% packet loss » CONTIENT
 * « 0% packet loss ». Ancree sur `, 0% packet loss` — la vraie ligne de
 * statistiques — elle tombe avant correctif, comme elle le devait. Le
 * meme piege avait deja ete paye une fois dans ce depot
 * (`nat-acl-evaluation-order`) ; les trois autres assertions de meme
 * forme des suites d'audit IPv6 et VACL ont ete ancrees en meme temps,
 * et leur discrimination (9 des 12) est inchangee, verifiee contre
 * l'etat pre-VACL.
 */
import { describe, it, expect } from 'vitest';
import { CiscoSwitch } from '@/network/devices/CiscoSwitch';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { Cable } from '@/network/hardware/Cable';
import { MACAddress, IPAddress, ETHERTYPE_ARP, type EthernetFrame } from '@/network/core/types';

async function lan(name: string, cableA: string, cableB: string) {
  const device = new CiscoSwitch('switch-cisco', name, 8);
  const left = new LinuxPC(`${name}-1`, `${name}A`, 0, 0);
  const right = new LinuxPC(`${name}-2`, `${name}B`, 0, 0);
  new Cable(cableA).connect(left.getPorts()[0], device.getPort('FastEthernet0/1')!);
  new Cable(cableB).connect(right.getPorts()[0], device.getPort('FastEthernet0/2')!);
  for (const c of ['enable', 'configure terminal', 'vlan 10', 'exit']) await device.executeCommand(c);
  for (const port of ['FastEthernet0/1', 'FastEthernet0/2']) {
    for (const c of [`interface ${port}`, 'switchport mode access', 'switchport access vlan 10', 'exit']) {
      await device.executeCommand(c);
    }
  }
  await device.executeCommand('end');
  await left.executeCommand('ifconfig eth0 10.0.0.1 netmask 255.255.255.0');
  await right.executeCommand('ifconfig eth0 10.0.0.2 netmask 255.255.255.0');
  return { device, left, right };
}

async function arpCrosses(left: LinuxPC, right: LinuxPC): Promise<boolean> {
  let seen = false;
  const farPort = right.getPorts()[0];
  const original = farPort.receiveFrame.bind(farPort);
  (farPort as unknown as { receiveFrame: (f: EthernetFrame) => void }).receiveFrame = (frame) => {
    if (frame.etherType === ETHERTYPE_ARP) seen = true;
    original(frame);
  };
  const src = left.getPorts()[0].getMAC();
  left.getPorts()[0].sendFrame({
    srcMAC: src, dstMAC: new MACAddress('ff:ff:ff:ff:ff:ff'), etherType: ETHERTYPE_ARP,
    payload: {
      operation: 1, senderMAC: src, senderIP: new IPAddress('10.0.0.1'),
      targetMAC: new MACAddress('00:00:00:00:00:00'), targetIP: new IPAddress('10.0.0.2'),
    },
  } as unknown as EthernetFrame);
  await Promise.resolve();
  (farPort as unknown as { receiveFrame: (f: EthernetFrame) => void }).receiveFrame = original;
  return seen;
}

async function configure(device: CiscoSwitch, lines: string[]): Promise<void> {
  for (const line of lines) await device.executeCommand(line);
}

describe('VACL — `match mac address` and the per-packet-type rule', () => {

  it('a MAC clause that matches drops the non-IP frame', async () => {
    const { device, left, right } = await lan('MA', 'ma1', 'ma2');
    await configure(device, [
      'enable', 'configure terminal',
      'mac access-list extended MACL', 'permit any any', 'exit',
      'vlan access-map M 10', 'match mac address MACL', 'action drop', 'exit',
      'vlan filter M vlan-list 10', 'end',
    ]);
    expect(device.getVlanAccessMap('M')![0].matchMacAcls).toEqual(['MACL']);
    expect(await arpCrosses(left, right)).toBe(false);
  }, 30000);

  it('a map carrying only MAC clauses FORWARDS IP traffic', async () => {
    const { device, left } = await lan('MB', 'mb1', 'mb2');
    await configure(device, [
      'enable', 'configure terminal',
      'mac access-list extended MACL', 'permit any any', 'exit',
      'vlan access-map M 10', 'match mac address MACL', 'action drop', 'exit',
      'vlan filter M vlan-list 10', 'end',
    ]);
    expect(await left.executeCommand('ping -c 2 10.0.0.2')).toContain(', 0% packet loss');
  }, 30000);

  it('a MAC clause that does NOT match still drops, by the implicit deny of its own type', async () => {
    const { device, left, right } = await lan('MC', 'mc1', 'mc2');
    await configure(device, [
      'enable', 'configure terminal',
      'mac access-list extended OTHER', 'permit host 0000.0000.9999 any', 'exit',
      'vlan access-map M 10', 'match mac address OTHER', 'action forward', 'exit',
      'vlan filter M vlan-list 10', 'end',
    ]);
    expect(await arpCrosses(left, right)).toBe(false);
  }, 30000);

  it('with no MAC clause at all, a non-IP frame is forwarded even when the map denies all IP', async () => {
    const { device, left, right } = await lan('MD', 'md1', 'md2');
    expect(await arpCrosses(left, right)).toBe(true);
    await configure(device, [
      'enable', 'configure terminal',
      'ip access-list extended AL', 'permit ip any any', 'exit',
      'vlan access-map M 10', 'match ip address AL', 'action drop', 'exit',
      'vlan filter M vlan-list 10', 'end',
    ]);
    expect(await arpCrosses(left, right)).toBe(true);
  }, 30000);

  it('an entry with no match clause still matches both types', async () => {
    const { device, left, right } = await lan('ME', 'me1', 'me2');
    await configure(device, [
      'enable', 'configure terminal',
      'vlan access-map M 10', 'action drop', 'exit',
      'vlan filter M vlan-list 10', 'end',
    ]);
    expect(await left.executeCommand('ping -c 2 10.0.0.2')).toContain('100% packet loss');
    expect(await arpCrosses(left, right)).toBe(false);
  }, 30000);

  it('the clause is rendered by both views', async () => {
    const device = new CiscoSwitch('switch-cisco', 'MF', 8);
    await configure(device, [
      'enable', 'configure terminal',
      'mac access-list extended MACL', 'permit any any', 'exit',
      'ip access-list extended AL', 'permit ip any any', 'exit',
      'vlan access-map M 10', 'match ip address AL', 'match mac address MACL',
      'action drop', 'exit', 'end',
    ]);
    const shown = await device.executeCommand('show vlan access-map');
    expect(shown).toContain('    ip  address: AL');
    expect(shown).toContain('    mac address: MACL');
    const config = await device.executeCommand('show running-config');
    expect(config).toContain(' match mac address MACL');
  }, 30000);
});
