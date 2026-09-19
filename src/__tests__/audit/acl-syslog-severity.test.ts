/*
 * Le journal d'ACL IPv4 porte la severite qu'IOS lui donne : 6.
 *
 * Constat trouve en donnant a l'IPv6 sa propre facilite
 * (`%IPV6_ACL-6-ACCESSLOGP`) : les deux ne s'accordaient pas sur la
 * severite d'un meme genre d'evenement. `LoggingConfig` empilait la
 * ligne IPv4 dans le seau `warnings`, et `formatEntry` derive le
 * chiffre du seau — d'ou `%SEC-4-IPACCESSLOGP` la ou Cisco ecrit
 * `%SEC-6-IPACCESSLOGP` (severite 6, « informational »).
 *
 * LE DEFAUT N'ETAIT PAS QUE D'AFFICHAGE, et c'est la mesure qui l'a
 * montre : le seau decide aussi de ce qu'un FILTRE retient.
 * `logging buffered notifications` (5) gardait la ligne, alors qu'un
 * message de severite 6 doit y etre ecarte. Un operateur qui resserre
 * le niveau pour reduire le bruit continuait de recevoir ses journaux
 * d'ACL.
 *
 * Reference : Cisco, « Understanding Access Control List Logging » —
 * `%SEC-6-IPACCESSLOGP: list 185 denied tcp 172.16.1.72(5775) ->
 * 192.168.2.1(408), 1 packet`. La forme du message etait deja exacte ;
 * seul le chiffre ne l'etait pas.
 *
 * DISCRIMINATION (`git stash` de `LoggingConfig.ts`) : les 3 cas
 * tombent. Il n'y a pas de cas passant des deux cotes ici — le lab
 * lui-meme est temoigne par le premier cas, qui echoue AVANT sur le
 * chiffre et non sur l'absence de ligne : la ligne sortait bien, avec
 * le mauvais numero.
 */
import { describe, it, expect } from 'vitest';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { CiscoSwitch } from '@/network/devices/CiscoSwitch';
import { Cable } from '@/network/hardware/Cable';
import { IPAddress, SubnetMask } from '@/network/core/types';

async function deniedConnectionLog(bufferCommand: string): Promise<string[]> {
  const client = new CiscoRouter('CLI');
  const server = new CiscoRouter('SRV');
  const sw = new CiscoSwitch('switch-cisco', 'SW', 4);
  new Cable('a').connect(client.getPort('GigabitEthernet0/0')!, sw.getPort('FastEthernet0/1')!);
  new Cable('b').connect(server.getPort('GigabitEthernet0/0')!, sw.getPort('FastEthernet0/2')!);
  client.getPort('GigabitEthernet0/0')!
    .configureIP(new IPAddress('10.0.0.1'), new SubnetMask('255.255.255.0'));
  server.getPort('GigabitEthernet0/0')!
    .configureIP(new IPAddress('10.0.0.2'), new SubnetMask('255.255.255.0'));

  for (const command of ['enable', 'configure terminal',
    'access-list 100 deny tcp any any eq 22 log', 'access-list 100 permit ip any any',
    'interface GigabitEthernet0/0', 'ip access-group 100 in', 'exit',
    bufferCommand, 'end']) {
    await Promise.resolve(server.executeCommand(command));
  }
  client.getTcpStack().connect('10.0.0.2', 22);
  const shown = await Promise.resolve(server.executeCommand('show logging'));
  return shown.split('\n').filter((line) => line.includes('IPACCESSLOGP'));
}

describe('the IPv4 ACL log carries the severity IOS gives it', () => {

  it('renders %SEC-6-IPACCESSLOGP, as Cisco documents it', async () => {
    const lines = await deniedConnectionLog('logging buffered 8000 debugging');
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('%SEC-6-IPACCESSLOGP');
    expect(lines[0]).toMatch(/list 100 denied tcp 10\.0\.0\.1\(\d+\) -> 10\.0\.0\.2\(22\), 1 packet/);
  }, 30000);

  it('a level-6 message survives an informational filter', async () => {
    const lines = await deniedConnectionLog('logging buffered 8000 informational');
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('%SEC-6-IPACCESSLOGP');
  }, 30000);

  it('a stricter filter drops it, which is what tightening the level is for', async () => {
    expect(await deniedConnectionLog('logging buffered 8000 notifications')).toHaveLength(0);
    expect(await deniedConnectionLog('logging buffered 8000 warnings')).toHaveLength(0);
  }, 30000);
});
