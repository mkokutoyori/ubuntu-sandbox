/**
 * On n'envoie pas d'ARP pour 0.0.0.0 — un saut suivant NON SPECIFIE
 * désigne la destination finale.
 *
 * MESURE DE DEPART. `ip route 10.5.0.0 255.255.0.0 GigabitEthernet0/1`
 * — la route par INTERFACE, sans saut suivant — installe une entree dont
 * le saut suivant vaut `0.0.0.0`. En acheminant vers une destination
 * couverte par elle, le routeur emettait une requete ARP pour
 * **0.0.0.0**, adresse qui ne peut repondre a personne :
 *
 *   TRAME Gi0/1 type=arp arpTarget=0.0.0.0
 *
 * RFC 1122 §3.2.1.3 : 0.0.0.0 est « this host on this network », jamais
 * une destination et jamais une cible d'ARP. Un vrai routeur, sur un
 * medium a diffusion, resout la DESTINATION FINALE et s'en remet au
 * proxy ARP du voisin — c'est precisement pourquoi Cisco deconseille
 * `ip route <reseau> <masque> <interface-ethernet>`.
 *
 * LE REPLI EXISTAIT ET NE POUVAIT PAS SE DECLENCHER. Quatre sites
 * ecrivaient `route.nextHop || destination`, ce qui dit bien « a defaut
 * de saut suivant, vise la destination » — mais `0.0.0.0` est un OBJET
 * `IPAddress`, donc VRAI, et le repli n'etait jamais pris. L'idiome
 * etait correct pour un `null` et faux pour l'adresse non specifiee.
 *
 * `nextHopTarget` est la regle unique que les quatre lisent, et
 * `IPAddress.isUnspecified()` est ajoutee a cote de `isLoopback()` —
 * `IPv6Address` la portait deja, la classe v4 non.
 *
 * DISCRIMINATION (`git stash` sur `Router.ts` et `core/types.ts`) : 4 des
 * 5 cas tombent — les deux cas d'ARP et les deux cas unitaires, ces
 * derniers pour une raison MECANIQUE (la methode n'existe pas encore,
 * donc l'appel echoue), ce qui est dit ici plutot que compte comme une
 * discrimination de comportement.
 *
 * Le cinquieme est le TEMOIN, et il passe des deux cotes : un vrai saut
 * suivant n'a jamais ete remplace par la destination, ni avant ni apres.
 * Sans lui, remplacer le saut suivant PARTOUT passerait la sonde en
 * ayant casse tout l'acheminement par routeur intermediaire.
 *
 * UNE HYPOTHESE ECARTEE PAR LA MESURE, ecrite plutot que tue : le TEMOIN
 * observait d'abord une requete ARP pour 172.16.1.10 et ne voyait RIEN,
 * le cache du routeur etant deja chaud. Ce n'etait pas un defaut mais un
 * laboratoire mal observe ; il regarde desormais l'adresse de couche
 * lien de la trame emise, qui ne depend pas de l'etat du cache.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { Cable } from '@/network/hardware/Cable';
import { resetCounters, MACAddress, IPAddress, ETHERTYPE_ARP } from '@/network/core/types';
import type { ARPPacket, EthernetFrame } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';

interface Cmd { executeCommand(cmd: string): Promise<string> }

async function taper(d: Cmd, cmds: string[]): Promise<string[]> {
  const out: string[] = [];
  for (const c of cmds) out.push(await d.executeCommand(c));
  return out;
}

beforeEach(() => {
  resetCounters(); resetDeviceCounters(); MACAddress.resetCounter(); Logger.reset();
});

async function laboratoire() {
  const routeur = new CiscoRouter('router-cisco', 'R1', 0, 0);
  const client = new LinuxPC('linux-pc', 'A', -200, 0);
  const voisin = new LinuxPC('linux-pc', 'C', 200, 0);
  new Cable('lan').connect(client.getPort('eth0')!, routeur.getPort('GigabitEthernet0/0')!);
  new Cable('wan').connect(voisin.getPort('eth0')!, routeur.getPort('GigabitEthernet0/1')!);
  await taper(routeur, ['enable', 'configure terminal',
    'interface GigabitEthernet0/0',
    'ip address 192.168.10.1 255.255.255.0', 'no shutdown', 'exit',
    'interface GigabitEthernet0/1',
    'ip address 172.16.1.1 255.255.255.0', 'no shutdown', 'exit',
    'ip route 10.5.0.0 255.255.0.0 GigabitEthernet0/1',
    'ip route 10.9.0.0 255.255.0.0 10.5.0.9',
    'ip route 10.6.0.0 255.255.0.0 172.16.1.10',
    'end']);
  await taper(client, ['ip link set eth0 up',
    'ip addr add 192.168.10.10/24 dev eth0', 'ip route add default via 192.168.10.1']);
  await taper(voisin, ['ip link set eth0 up',
    'ip addr add 172.16.1.10/24 dev eth0', 'ip route add default via 172.16.1.1']);
  return { routeur, client, voisin };
}

function ciblesArp(routeur: CiscoRouter, iface: string): string[] {
  const vues: string[] = [];
  const port = routeur.getPort(iface)!;
  const original = port.sendFrame.bind(port);
  (port as unknown as { sendFrame: unknown }).sendFrame = (f: EthernetFrame) => {
    if (f.etherType === ETHERTYPE_ARP) {
      const arp = f.payload as ARPPacket | undefined;
      if (arp?.type === 'arp' && arp.operation === 'request') {
        vues.push(arp.targetIP.toString());
      }
    }
    return original(f as never);
  };
  return vues;
}

describe('un saut suivant non specifie vise la DESTINATION', () => {
  it('l\'ARP ne porte jamais 0.0.0.0', async () => {
    const { routeur, client } = await laboratoire();
    const cibles = ciblesArp(routeur, 'GigabitEthernet0/1');
    await client.executeCommand('ping -c 1 10.9.0.1');
    expect(cibles.length).toBeGreaterThan(0);
    expect(cibles).not.toContain('0.0.0.0');
  });

  it('il porte la destination finale', async () => {
    const { routeur, client } = await laboratoire();
    const cibles = ciblesArp(routeur, 'GigabitEthernet0/1');
    await client.executeCommand('ping -c 1 10.9.0.1');
    expect(cibles).toContain('10.9.0.1');
  });

  it('TEMOIN — un vrai saut suivant n\'est PAS remplace par la destination', async () => {
    const { routeur, client, voisin } = await laboratoire();
    const cibles = ciblesArp(routeur, 'GigabitEthernet0/1');
    const versLeVoisin: string[] = [];
    const port = routeur.getPort('GigabitEthernet0/1')!;
    const original = port.sendFrame.bind(port);
    (port as unknown as { sendFrame: unknown }).sendFrame = (f: EthernetFrame) => {
      if (f.etherType !== ETHERTYPE_ARP) versLeVoisin.push(f.dstMAC.toString());
      return original(f as never);
    };
    await client.executeCommand('ping -c 1 10.6.0.1');
    expect(cibles).not.toContain('10.6.0.1');
    expect(versLeVoisin).toContain(voisin.getPort('eth0')!.getMAC().toString());
  });
});

describe('et la classe IPv4 sait dire ce qu\'est 0.0.0.0', () => {
  it('l\'adresse non specifiee est reconnue', () => {
    expect(new IPAddress('0.0.0.0').isUnspecified()).toBe(true);
  });

  it('et une adresse ordinaire ne l\'est pas', () => {
    expect(new IPAddress('10.0.0.1').isUnspecified()).toBe(false);
    expect(new IPAddress('0.0.0.1').isUnspecified()).toBe(false);
    expect(new IPAddress('255.255.255.255').isUnspecified()).toBe(false);
  });
});
