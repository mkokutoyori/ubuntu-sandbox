/**
 * Suite de RELEVE (pas d'assertions de contrat) — `src/__tests__/debug/`.
 *
 * Deux manquements voisins, au meme joint :
 *
 *   `TODO.md` [acl] : VRP n'a pas `traffic-filter vlan <n> inbound`,
 *   l'equivalent de la carte d'acces de VLAN de Cisco. Un laboratoire
 *   VACL est donc infaisable sur VRP.
 *
 *   Et, decouvert en lisant le point d'appel : `floodFrame` ne consulte
 *   PAS `portAclPermits` — seul `forwardToPort` le fait. Un
 *   `traffic-filter outbound` pose sur un port filtrerait donc l'unicast
 *   APPRIS et laisserait passer la diffusion, l'unicast inconnu et le
 *   multicast par le meme port.
 *
 * Le cas d'inondation se lit en DIFFERENCE, jamais en absolu : une ACL
 * IPv4 ne filtre pas l'ARP, et `ping -b` en met sur le fil avant les
 * deux diffusions IPv4. Compter << zero trame recue >> serait une
 * fausse attente ; ce qui se mesure est l'ecart entre le meme echange
 * avec et sans le filtre.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { HuaweiSwitch } from '@/network/devices/HuaweiSwitch';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { Cable } from '@/network/hardware/Cable';
import { MACAddress, resetCounters } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import { Logger } from '@/network/core/Logger';
import { pingOnSimulatedClock } from '../../support/fastPing';

beforeEach(() => {
  resetCounters(); MACAddress.resetCounter(); resetDeviceCounters();
  Logger.reset(); EquipmentRegistry.resetInstance();
});

const note = (l: string) => { console.log(l); };

async function vrp(sw: HuaweiSwitch, lignes: string[]): Promise<string> {
  let out = '';
  for (const c of lignes) out = await sw.executeCommand(c);
  return out;
}

const perte = async (pc: LinuxPC, ip: string): Promise<string> =>
  (await pingOnSimulatedClock(pc, `ping -c 2 -W 1 ${ip}`))
    .split('\n').filter((l) => /packet loss/.test(l)).join('').trim();

function labo() {
  const sw = new HuaweiSwitch('switch-huawei', 'SW', 5);
  const a = new LinuxPC('linux-pc', 'PC-A', 0, 0);
  const b = new LinuxPC('linux-pc', 'PC-B', 0, 0);
  new Cable('ca').connect(a.getPort('eth0')!, sw.getPort('GigabitEthernet0/0/1')!);
  new Cable('cb').connect(b.getPort('eth0')!, sw.getPort('GigabitEthernet0/0/2')!);
  return { sw, a, b };
}

async function adresser(a: LinuxPC, b: LinuxPC): Promise<void> {
  await a.executeCommand('ifconfig eth0 192.168.1.10 netmask 255.255.255.0');
  await b.executeCommand('ifconfig eth0 192.168.1.20 netmask 255.255.255.0');
}

describe('VACL VRP et filtre de port sur les trames inondees', () => {
  it('traffic-filter vlan <n> inbound : la commande existe-t-elle, et applique-t-elle ?', async () => {
    const { sw, a, b } = labo();
    await adresser(a, b);
    note(`[vacl-T] TEMOIN avant tout filtrage : ${await perte(a, '192.168.1.20')}`);

    const pose = await vrp(sw, ['system-view',
      'acl number 3000',
      'rule 5 deny ip source 192.168.1.10 0',
      'rule 10 permit ip source any destination any',
      'quit']);
    note(`[vacl-1] ACL 3000 posee : ${pose.trim() === '' ? 'oui (silence)' : JSON.stringify(pose.trim())}`);

    const liaison = await sw.executeCommand('traffic-filter vlan 1 inbound acl 3000');
    note(`[vacl-2] traffic-filter vlan 1 inbound acl 3000 : ${
      liaison.trim() === '' ? 'accepte (silence)' : JSON.stringify(liaison.trim())}`);

    await sw.executeCommand('return');
    const conf = await sw.executeCommand('display current-configuration');
    note(`[vacl-3] rendu par display current-configuration : ${
      conf.split('\n').filter((l) => /traffic-filter vlan/.test(l)).join(' | ').trim() || 'RIEN'}`);
    note(`[vacl-4] ping APRES le filtre de VLAN : ${await perte(a, '192.168.1.20')}`);

    const { sw: sw2, a: a2, b: b2 } = labo();
    await adresser(a2, b2);
    await vrp(sw2, ['system-view',
      'acl number 3000',
      'rule 5 deny ip source 192.168.1.99 0',
      'rule 10 permit ip source any destination any',
      'quit',
      'traffic-filter vlan 1 inbound acl 3000', 'return']);
    note(`[vacl-5] TEMOIN — meme filtre, source NON visee : ${await perte(a2, '192.168.1.20')}`);
    expect(true).toBe(true);
  }, 60000);

  it('traffic-filter outbound : filtre-t-il aussi ce qui est INONDE ?', async () => {
    const { sw, a, b } = labo();
    await adresser(a, b);
    note(`[flood-T] TEMOIN avant filtrage : ${await perte(a, '192.168.1.20')}`);

    await vrp(sw, ['system-view',
      'acl number 3000',
      'rule 5 deny ip destination 192.168.1.20 0',
      'rule 10 permit ip source any destination any',
      'quit',
      'interface GigabitEthernet 0/0/2',
      'traffic-filter outbound acl 3000',
      'quit', 'return']);
    note(`[flood-1] unicast APRES traffic-filter outbound : ${await perte(a, '192.168.1.20')}`);

    const { sw: sw2, a: a2, b: b2 } = labo();
    await adresser(a2, b2);
    await vrp(sw2, ['system-view',
      'acl number 3000',
      'rule 5 deny ip destination 192.168.1.255 0',
      'rule 10 permit ip source any destination any',
      'quit',
      'interface GigabitEthernet 0/0/2',
      'traffic-filter outbound acl 3000',
      'quit', 'return']);
    const avant = b2.getPort('eth0')!.getCounters().framesIn;
    await a2.executeCommand('ping -c 2 -b 192.168.1.255');
    const apres = b2.getPort('eth0')!.getCounters().framesIn;
    note(`[flood-2] diffusion vers 192.168.1.255, refusee par l ACL de sortie : ${
      apres - avant} trame(s) recue(s) par PC-B`);

    const { sw: sw3, a: a3, b: b3 } = labo();
    await adresser(a3, b3);
    const avant3 = b3.getPort('eth0')!.getCounters().framesIn;
    await a3.executeCommand('ping -c 2 -b 192.168.1.255');
    const apres3 = b3.getPort('eth0')!.getCounters().framesIn;
    note(`[flood-3] TEMOIN — meme diffusion SANS aucun filtre : ${
      apres3 - avant3} trame(s) recue(s) par PC-B`);
    note('[flood-4] la DIFFERENCE est ce qui compte : une ACL IPv4 ne filtre'
      + ' pas l ARP, donc seules les deux diffusions IPv4 doivent tomber.');
    expect(true).toBe(true);
  }, 60000);
});
