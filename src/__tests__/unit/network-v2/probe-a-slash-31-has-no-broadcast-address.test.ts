/**
 * Un prefixe /31 n'a pas d'adresse de diffusion, un /32 non plus.
 *
 * Mesure de depart : un hote derriere le routeur A ne joignait pas
 * l'adresse d'en face d'un lien point a point 10.0.0.0/31 — 100 % de
 * perte — alors que le ping direct de A a B passait. `isDirectedBroadcast`
 * jugeait toute adresse dont les bits d'hote sont a un comme la diffusion
 * dirigee du prefixe connecte ; sur un /31, 10.0.0.1 l'est, et le routeur
 * la jetait comme une diffusion dirigee refusee (`no ip directed-broadcast`).
 * La meme regle rendait l'adresse d'une Loopback /32 « diffusion » de son
 * propre prefixe, ce qui faisait repondre l'agent SNMP depuis l'interface
 * d'entree au lieu de l'adresse interrogee (cas couvert par
 * `probe-snmpwalk-walks-the-wire`).
 *
 * L'autorite est la RFC 3021 §2.2 : sur un /31, les deux adresses sont
 * des adresses d'hote, il n'y a ni adresse de reseau ni adresse de
 * diffusion. IOS l'applique depuis 12.2(2)T.
 *
 * Discrimination, mesuree en retirant le correctif : 1 des 2 cas tombe.
 * « WITNESS: a /30 peer is reached through the router » passe des deux
 * cotes ; il prouve que le banc route, et donc que le cas /31 tombe pour
 * la raison qu'il nomme.
 */
import { describe, it, expect } from 'vitest';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { Cable } from '@/network/hardware/Cable';

async function pingAcross(mask: string, near: string, far: string): Promise<string> {
  const a = new CiscoRouter('A');
  const b = new CiscoRouter('B');
  const pc = new LinuxPC('PC');
  new Cable('p2p').connect(a.getPort('GigabitEthernet0/0')!, b.getPort('GigabitEthernet0/0')!);
  new Cable('lan').connect(a.getPort('GigabitEthernet0/1')!, pc.getPorts()[0]);
  for (const command of ['enable', 'configure terminal',
    'interface GigabitEthernet0/0', `ip address ${near} ${mask}`, 'no shutdown', 'exit',
    'interface GigabitEthernet0/1', 'ip address 10.1.0.1 255.255.255.0', 'no shutdown', 'end']) {
    await a.executeCommand(command);
  }
  for (const command of ['enable', 'configure terminal',
    'interface GigabitEthernet0/0', `ip address ${far} ${mask}`, 'no shutdown', 'exit',
    `ip route 10.1.0.0 255.255.255.0 ${near}`, 'end']) {
    await b.executeCommand(command);
  }
  for (const command of ['sudo ip addr add 10.1.0.10/24 dev eth0', 'sudo ip link set eth0 up',
    'sudo ip route add default via 10.1.0.1']) {
    await pc.executeCommand(command);
  }
  return pc.executeCommand(`ping -c 2 ${far}`);
}

describe('a point-to-point prefix has no directed broadcast', () => {
  it('WITNESS: a /30 peer is reached through the router', async () => {
    expect(await pingAcross('255.255.255.252', '10.0.0.1', '10.0.0.2')).toContain(' 0% packet loss');
  });

  it('a /31 peer is reached through the router (RFC 3021)', async () => {
    expect(await pingAcross('255.255.255.254', '10.0.0.0', '10.0.0.1')).toContain(' 0% packet loss');
  });
});
