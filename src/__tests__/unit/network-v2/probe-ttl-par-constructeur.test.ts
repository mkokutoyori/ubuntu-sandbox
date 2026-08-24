/**
 * Un routeur ne decremente pas ce qu'il ORIGINE.
 *
 * Mesure de depart, sur un commutateur portant un poste Linux, un poste
 * Windows, un routeur Cisco et un routeur Huawei :
 *
 *   ping 10.0.0.3 (Cisco)  -> ttl=254   PUIS ttl=255 au deuxieme essai
 *   ping 10.0.0.4 (Huawei) -> ttl=254   PUIS ttl=255 au deuxieme essai
 *
 * La meme commande, la meme machine, deux reponses selon l'etat du cache
 * ARP. La reponse d'echo est construite a 255 puis part par deux chemins
 * differents : si l'adresse du demandeur est deja dans la table ARP elle
 * est emise directement (255), sinon elle passe par `forwardPacket` —
 * le chemin du TRANSIT — qui decremente. Un routeur qui decremente sa
 * PROPRE reponse n'existe pas, et l'empreinte TTL (255 routeur, 128
 * Windows, 64 Linux) est le premier reflexe d'identification d'un hote.
 *
 * Ce n'etait pas que le TTL : `forwardPacket` emet aussi une redirection
 * ICMP, traduit par NAT et applique la liste de controle SORTANTE, dont
 * IOS dit qu'elle ne filtre justement pas le trafic que le routeur
 * genere lui-meme.
 *
 * `sendSelfOriginatedIPv4` est desormais l'unique chemin du trafic
 * originé par le routeur — route, puis `sendIpv4FrameArpAware`, qui sait
 * deja mettre en file et resoudre sur un cache froid. Il ne touche ni au
 * TTL, ni au NAT, ni aux listes. Les trois copies quasi identiques qui
 * existaient (reponse d'echo, erreur ICMP, redirection ICMP) le lisent.
 *
 * Le cas qui passe des deux cotes est nomme : « une erreur ICMP du
 * routeur part elle aussi a 255 » — `sendICMPError` faisait DEJA la
 * bonne chose, c'est la reponse d'echo qui avait diverge ; il garde donc
 * que l'extraction ne l'a pas casse.
 *
 * Les valeurs par constructeur sont celles des vraies machines : 255
 * pour un routeur IOS ou VRP, 128 sous Windows, 64 sous Linux et sur un
 * FortiGate, dont le noyau est derive de Linux et dont la documentation
 * Fortinet donne 64 comme TTL de `execute ping`.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { HuaweiRouter } from '@/network/devices/HuaweiRouter';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { WindowsPC } from '@/network/devices/WindowsPC';
import { FortiGate } from '@/network/devices/firewall/vendors/fortios/FortiGate';
import { FortiShell } from '@/network/devices/firewall/vendors/fortios/FortiShell';
import { GenericSwitch } from '@/network/devices/GenericSwitch';
import { Cable } from '@/network/hardware/Cable';
import { IPAddress, SubnetMask, MACAddress, resetCounters } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';

async function lab() {
  const sw = new GenericSwitch('switch-generic', 'SW', 8, 0, 0);
  const sonde = new LinuxPC('linux-pc', 'SONDE');
  const linux = new LinuxPC('linux-pc', 'LIN');
  const windows = new WindowsPC('windows-pc', 'WIN');
  const cisco = new CiscoRouter('R1');
  const huawei = new HuaweiRouter('R2');
  const forti = new FortiGate('firewall-fortinet', 'FGT', 0, 0);

  const ordre = [sonde, linux, windows, cisco, huawei, forti];
  ordre.forEach((d, i) => new Cable(`c${i}`).connect(d.getPorts()[0], sw.getPorts()[i]));

  sonde.configureInterface('eth0', new IPAddress('10.0.0.1'), new SubnetMask('255.255.255.0'));
  linux.configureInterface('eth0', new IPAddress('10.0.0.2'), new SubnetMask('255.255.255.0'));
  windows.configureInterface('eth0', new IPAddress('10.0.0.3'), new SubnetMask('255.255.255.0'));
  for (const c of ['enable', 'configure terminal', 'interface GigabitEthernet0/0',
    'ip address 10.0.0.4 255.255.255.0', 'no shutdown', 'end']) await cisco.executeCommand(c);
  for (const c of ['system-view', 'interface GigabitEthernet0/0/0',
    'ip address 10.0.0.5 255.255.255.0', 'undo shutdown', 'quit', 'quit']) await huawei.executeCommand(c);
  const sh = new FortiShell(forti);
  for (const c of ['config system interface', 'edit "port1"', 'set mode static',
    'set ip 10.0.0.6 255.255.255.0', 'set allowaccess ping', 'next', 'end']) sh.execute(c);

  return { sonde };
}

const ttlDe = (sortie: string): number | null => {
  const m = /ttl=(\d+)/.exec(sortie);
  return m ? parseInt(m[1], 10) : null;
};

describe('le TTL de chaque constructeur', () => {
  beforeEach(() => { resetCounters(); resetDeviceCounters(); MACAddress.resetCounter(); });

  it('le PREMIER ping vers un routeur rend deja 255', async () => {
    const { sonde } = await lab();
    expect(ttlDe(await sonde.executeCommand('ping -c 1 10.0.0.4'))).toBe(255);
  }, 30000);

  it('le premier et le second ping rendent le MEME TTL', async () => {
    const { sonde } = await lab();
    const premier = ttlDe(await sonde.executeCommand('ping -c 1 10.0.0.4'));
    const second = ttlDe(await sonde.executeCommand('ping -c 1 10.0.0.4'));
    expect(premier).toBe(second);
  }, 30000);

  it('chaque constructeur porte son empreinte', async () => {
    const { sonde } = await lab();
    const attendu: Array<[string, string, number]> = [
      ['Linux', '10.0.0.2', 64],
      ['Windows', '10.0.0.3', 128],
      ['Cisco IOS', '10.0.0.4', 255],
      ['Huawei VRP', '10.0.0.5', 255],
      ['FortiGate', '10.0.0.6', 64],
    ];
    for (const [nom, ip, ttl] of attendu) {
      expect(ttlDe(await sonde.executeCommand(`ping -c 1 ${ip}`)), nom).toBe(ttl);
    }
  }, 30000);

  it('une erreur ICMP du routeur part elle aussi a 255', async () => {
    const { sonde } = await lab();
    await sonde.executeCommand('ip route add 172.31.0.0/16 via 10.0.0.4');
    const out = await sonde.executeCommand('ping -c 1 172.31.9.9');
    expect(out).toContain('Destination Net Unreachable');
  }, 30000);
});
