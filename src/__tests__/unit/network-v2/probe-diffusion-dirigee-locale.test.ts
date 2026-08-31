/**
 * On n'envoie pas d'ARP pour une adresse de DIFFUSION — RFC 1122 §3.3.6.
 *
 * MESURE DE DEPART. Deux hotes sur 192.168.10.0/24 relies par un
 * commutateur. `ping -b 192.168.10.255` depuis le premier — la diffusion
 * dirigee de son PROPRE sous-reseau — n'emettait AUCUN paquet IPv4. La
 * seule trame sortie etait :
 *
 *   et=0x806 type=arp dst=192.168.10.255 mac=ff:ff:ff:ff:ff:ff
 *
 * c'est-a-dire une requete ARP pour l'adresse de diffusion elle-meme.
 * Personne ne vit a .255, donc cette requete n'a pas de reponse possible
 * et l'echo n'est jamais parti.
 *
 * RFC 1122 §3.3.6 : une diffusion dirigee vers un reseau DIRECTEMENT
 * CONNECTE se remet a l'adresse de diffusion de couche lien. Il n'y a
 * rien a resoudre — l'adresse de destination EST deja l'adresse de
 * tout le monde.
 *
 * C'EST LA MEME FORME QUE L'ARP POUR 0.0.0.0 fermee juste avant, un
 * etage plus haut : l'emetteur pose a ARP une question sans reponse
 * possible. Et la regle existait DEJA dans la couche —
 * `isDirectedBroadcast` y vit depuis la phase 2 — mais
 * `linkDestinationFor`, qui repond « quelle adresse de couche lien pour
 * cette destination », ne la consultait pas : elle rendait `null` pour
 * tout ce qui est unicast, et une diffusion dirigee EST classee unicast.
 * Les deux emetteurs ARP-conscients (hote et routeur) la consultent
 * desormais avant de regarder le cache ARP.
 *
 * QUATRE EMETTEURS REPONDAIENT A LA MEME QUESTION, et c'est le fond du
 * lot : « quelle adresse de couche lien pour cette destination » est
 * re-decidee a chaque point d'emission —
 * `EndHost.sendIpv4FrameArpAware`, `EndHost.sendPingProbeSync`,
 * `EndHost.executePingSequence` et `Router.sendIpv4FrameArpAware` — et
 * AUCUN ne consultait la couche. Les quatre la lisent desormais.
 *
 * DISCRIMINATION (`git stash` sur les quatre fichiers) : 4 des 8 cas
 * tombent — les quatre observations de la diffusion locale. Les 4 autres
 * sont le TEMOIN unicast, qui garde qu'on n'a pas mis TOUT le trafic en
 * diffusion, et les trois cas unitaires de `linkDestinationFor`, dont
 * deux passent des deux cotes puisqu'ils decrivent ce qu'elle rendait
 * deja (`null` hors du sous-reseau connecte).
 *
 * UNE ERREUR DE MA PART, ecrite plutot que tue : le TEMOIN attendait
 * d'abord une requete ARP pour 192.168.10.20 et n'en voyait aucune, le
 * cache etant deja chaud apres la configuration d'adresse. C'est le
 * MEME piege que dans la sonde du saut suivant non specifie, retombe
 * dedans une sonde plus tard ; il observe desormais l'adresse de couche
 * lien de la trame, qui ne depend pas du cache.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { GenericSwitch } from '@/network/devices/GenericSwitch';
import { Cable } from '@/network/hardware/Cable';
import {
  resetCounters, MACAddress, IPAddress, SubnetMask,
  ETHERTYPE_IPV4, ETHERTYPE_ARP,
} from '@/network/core/types';
import type { EthernetFrame, IPv4Packet, ARPPacket } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { linkDestinationFor } from '@/network/layers/internet/Ipv4Egress';

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
  const commutateur = new GenericSwitch('switch-generic', 'SW', 8, 0, 0);
  const a = new LinuxPC('linux-pc', 'A', -200, 0);
  const b = new LinuxPC('linux-pc', 'B', 200, 0);
  new Cable('a').connect(a.getPort('eth0')!, commutateur.getPort('eth0')!);
  new Cable('b').connect(b.getPort('eth0')!, commutateur.getPort('eth1')!);
  await taper(a, ['ip link set eth0 up', 'ip addr add 192.168.10.10/24 dev eth0']);
  await taper(b, ['ip link set eth0 up', 'ip addr add 192.168.10.20/24 dev eth0']);
  return { a, b };
}

interface Sorties { ipv4: IPv4Packet[]; ciblesArp: string[]; macs: string[] }

function observer(pc: LinuxPC): Sorties {
  const s: Sorties = { ipv4: [], ciblesArp: [], macs: [] };
  const port = pc.getPort('eth0')!;
  const original = port.sendFrame.bind(port);
  (port as unknown as { sendFrame: unknown }).sendFrame = (f: EthernetFrame) => {
    if (f.etherType === ETHERTYPE_IPV4) {
      s.ipv4.push(f.payload as IPv4Packet);
      s.macs.push(f.dstMAC.toString().toLowerCase());
    }
    if (f.etherType === ETHERTYPE_ARP) {
      const arp = f.payload as ARPPacket | undefined;
      if (arp?.type === 'arp' && arp.operation === 'request') {
        s.ciblesArp.push(arp.targetIP.toString());
      }
    }
    return original(f as never);
  };
  return s;
}

describe('une diffusion dirigee LOCALE part sur le fil', () => {
  it('aucun ARP n\'est emis pour l\'adresse de diffusion', async () => {
    const { a } = await laboratoire();
    const vues = observer(a);
    await a.executeCommand('ping -c 1 -b 192.168.10.255');
    expect(vues.ciblesArp).not.toContain('192.168.10.255');
  });

  it('un paquet IPv4 est REELLEMENT emis', async () => {
    const { a } = await laboratoire();
    const vues = observer(a);
    await a.executeCommand('ping -c 1 -b 192.168.10.255');
    expect(vues.ipv4.length).toBeGreaterThan(0);
  });

  it('et il part vers l\'adresse de diffusion de couche lien', async () => {
    const { a } = await laboratoire();
    const vues = observer(a);
    await a.executeCommand('ping -c 1 -b 192.168.10.255');
    expect(vues.macs).toContain('ff:ff:ff:ff:ff:ff');
  });

  it('le voisin du meme segment la RECOIT', async () => {
    const { a, b } = await laboratoire();
    const avant = b.getPort('eth0')!.getCounters().framesIn;
    await a.executeCommand('ping -c 1 -b 192.168.10.255');
    expect(b.getPort('eth0')!.getCounters().framesIn).toBeGreaterThan(avant);
  });

  it('TEMOIN — un unicast ordinaire ne part PAS en diffusion', async () => {
    const { a, b } = await laboratoire();
    const vues = observer(a);
    await a.executeCommand('ping -c 1 192.168.10.20');
    expect(vues.ipv4.length).toBeGreaterThan(0);
    expect(vues.macs).not.toContain('ff:ff:ff:ff:ff:ff');
    expect(vues.macs).toContain(b.getPort('eth0')!.getMAC().toString().toLowerCase());
  });
});

describe('et la regle vit dans la couche, pas dans l\'emetteur', () => {
  const connecte = [{
    address: new IPAddress('192.168.10.10'), mask: new SubnetMask('255.255.255.0'),
  }];

  it('la diffusion du sous-reseau connecte rend l\'adresse de diffusion', () => {
    expect(linkDestinationFor(new IPAddress('192.168.10.255'), connecte)?.toString()
      .toLowerCase()).toBe('ff:ff:ff:ff:ff:ff');
  });

  it('celle d\'un AUTRE sous-reseau reste a resoudre', () => {
    expect(linkDestinationFor(new IPAddress('192.168.99.255'), connecte)).toBeNull();
  });

  it('et un hote ordinaire aussi', () => {
    expect(linkDestinationFor(new IPAddress('192.168.10.20'), connecte)).toBeNull();
  });
});
