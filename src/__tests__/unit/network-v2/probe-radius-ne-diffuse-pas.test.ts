/**
 * Une requete RADIUS ne se DIFFUSE pas, et la sortie est celle que la
 * table de routage designe (BRD §3.3 / §5.4).
 *
 * ── Ce que la mesure a trouve, et ce qu'elle N'A PAS trouve ────────
 *
 * Le lot 7 de la phase 5 avait converti la CONSTRUCTION du paquet RADIUS
 * (`buildUdpOverIpv4`) et laisse l'EMISSION intacte. Les cinq fichiers
 * de `radius/` batissaient donc encore leur trame, et tous portaient la
 * meme retombee :
 *
 *     dstMAC: this.host.resolveMac?.(dstIp) ?? MACAddress.broadcast()
 *
 * `resolveMac` LIT le cache ARP, il ne resout pas. La retombee promettait
 * donc une diffusion de la requete d'authentification sur cache froid --
 * et il faut dire tout de suite ce que la mesure a etabli : sur un
 * ROUTEUR elle n'etait pas atteignable. Le client passait par la branche
 * `sendIpv4FrameArpAware`, que tout routeur fournit ; et la reponse du
 * serveur, qui elle n'avait AUCUNE garde, trouvait toujours l'adresse
 * dans le cache, la trame de la requete venant de l'y mettre. Les quatre
 * cas sur le fil ci-dessous passent donc des deux cotes, et c'est ce
 * qu'ils doivent faire : ce sont des temoins de non-regression.
 *
 * Ou la retombee etait-elle VIVE ? Sur un hote qui ne fournit pas
 * `resolveMac` du tout -- le `RadiusServerHost` de `WindowsNpsRole` n'en
 * avait pas --, ou `?? MACAddress.broadcast()` etait alors incondition-
 * nel : chaque Access-Accept partait en diffusion. Monter ce laboratoire
 * NPS depasse ce fichier ; le cas de STRUCTURE ferme la porte pour de
 * bon, en interdisant la retombee elle-meme.
 *
 * Chaque fichier portait de surcroit sa propre copie de `resolveEgress`,
 * dont le repli prend « le premier port adresse et up » quelle que soit
 * la direction de la cible -- la meme que le lot 8 avait retiree de
 * syslog, NetFlow et SNMP. Les cinq disparaissent : la sortie suit
 * desormais la table de routage.
 *
 * ── Ce qu'il a fallu ajouter pour que la descente soit possible ─────
 *
 * Une application qui doit NOMMER sa propre adresse dans son message —
 * `nas-ip-address` pour RADIUS, comme `agent-addr` pour SNMP — a besoin
 * de savoir laquelle la pile emploiera AVANT d'emettre. C'est la
 * question que `ip route get` pose sur une vraie machine, et la couche
 * ne savait pas y repondre : `sourceAddressFor` l'ajoute, et les cinq
 * copies de `resolveEgress` disparaissent avec.
 *
 * `EndHost.sendUdpDatagram` etait POSITIONNEL la ou `Router` et `Switch`
 * prennent une requete — un meme nom pour deux formes, et le blocage que
 * le `TODO.md` nommait. Il accepte desormais les deux ECRITURES sur une
 * SEULE implantation, donc les 83 appels positionnels restent valides et
 * un agent hebergé par un hote peut appeler l'offre comme sur un routeur.
 *
 * ── Discrimination ─────────────────────────────────────────────────
 *
 * UN seul cas sur six tombe contre l'etat d'avant, et c'est le cas de
 * STRUCTURE. Les cinq autres sont des temoins, pour la raison dite plus
 * haut : la retombee en diffusion n'etait pas atteignable sur un
 * routeur, donc aucun laboratoire de routeur ne peut la montrer. Le
 * dire vaut mieux que de faire passer cinq temoins pour des preuves.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { CiscoSwitch } from '@/network/devices/CiscoSwitch';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { Cable } from '@/network/hardware/Cable';
import {
  resetCounters, MACAddress, IPAddress, SubnetMask, type IPv4Packet, type UDPPacket,
} from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  MACAddress.resetCounter();
  Logger.reset();
});

const RADIUS_AUTH = 1812;

interface Vu { dstMAC: string; packet: IPv4Packet }

function radiusInto(device: { getPorts(): Array<{ attachTap(t: (f: {
  direction: string; frame: { dstMAC: { toString(): string }; payload: unknown };
}) => void): unknown }> }): Vu[] {
  const seen: Vu[] = [];
  for (const p of device.getPorts()) {
    p.attachTap(({ direction, frame }) => {
      if (direction !== 'in') return;
      const packet = frame.payload as IPv4Packet | undefined;
      if (packet?.type !== 'ipv4') return;
      const udp = packet.payload as UDPPacket | undefined;
      if (udp?.type === 'udp' && udp.destinationPort === RADIUS_AUTH) {
        seen.push({ dstMAC: frame.dstMAC.toString(), packet });
      }
    });
  }
  return seen;
}

function repliesInto(device: { getPorts(): Array<{ attachTap(t: (f: {
  direction: string; frame: { dstMAC: { toString(): string }; payload: unknown };
}) => void): unknown }> }): Vu[] {
  const seen: Vu[] = [];
  for (const p of device.getPorts()) {
    p.attachTap(({ direction, frame }) => {
      if (direction !== 'in') return;
      const packet = frame.payload as IPv4Packet | undefined;
      if (packet?.type !== 'ipv4') return;
      const udp = packet.payload as UDPPacket | undefined;
      if (udp?.type === 'udp' && udp.sourcePort === RADIUS_AUTH) {
        seen.push({ dstMAC: frame.dstMAC.toString(), packet });
      }
    });
  }
  return seen;
}

async function segment() {
  const sw = new CiscoSwitch('switch-cisco', 'SW', 8);
  const nas = new CiscoRouter('NAS');
  const server = new CiscoRouter('AAA');
  const bystander = new LinuxPC('PC');

  new Cable('c1').connect(nas.getPort('GigabitEthernet0/0')!, sw.getPort('FastEthernet0/1')!);
  new Cable('c2').connect(server.getPort('GigabitEthernet0/0')!, sw.getPort('FastEthernet0/2')!);
  new Cable('c3').connect(bystander.getPorts()[0], sw.getPort('FastEthernet0/3')!);

  for (const [r, ip] of [[nas, '10.0.0.1'], [server, '10.0.0.2']] as const) {
    r.getPort('GigabitEthernet0/0')!
      .configureIP(new IPAddress(ip), new SubnetMask('255.255.255.0'));
    for (const c of ['enable', 'configure terminal', 'interface GigabitEthernet0/0',
      'no shutdown', 'end']) await r.executeCommand(c);
  }
  // Cache ARP froid : c'est l'etat du PREMIER paquet, celui ou la
  // retombee diffusait.
  nas._clearArpEntry('10.0.0.2');
  return { sw, nas, server, bystander };
}

function askRadius(nas: CiscoRouter): void {
  const client = nas.getRadiusClient();
  client.start();
  client.addServer('10.0.0.2', 'secret', { port: RADIUS_AUTH });
  void client.authenticate('alice', 'motdepasse');
}

describe('une requete RADIUS ne part pas en diffusion', () => {
  it('le tiers du segment ne recoit AUCUNE requete RADIUS', async () => {
    const { nas, bystander } = await segment();
    const chezLeTiers = radiusInto(bystander);
    askRadius(nas);
    expect(chezLeTiers).toEqual([]);
  });

  it('TEMOIN — le SERVEUR, lui, la recoit', async () => {
    const { nas, server } = await segment();
    const chezLeServeur = radiusInto(server);
    askRadius(nas);
    expect(chezLeServeur.length).toBeGreaterThan(0);
  });

  it('la trame porte l\'adresse du SERVEUR et non la diffusion', async () => {
    const { nas, server } = await segment();
    const chezLeServeur = radiusInto(server);
    const macDuServeur = server.getPort('GigabitEthernet0/0')!.getMAC().toString();
    askRadius(nas);

    expect(chezLeServeur.length).toBeGreaterThan(0);
    for (const f of chezLeServeur) {
      expect(f.dstMAC).toBe(macDuServeur);
      expect(f.dstMAC).not.toBe(MACAddress.broadcast().toString());
    }
  });

  it('TEMOIN — l\'adresse source annoncee est celle de l\'interface de sortie', async () => {
    const { nas, server } = await segment();
    const chezLeServeur = radiusInto(server);
    askRadius(nas);

    expect(chezLeServeur.length).toBeGreaterThan(0);
    for (const f of chezLeServeur) {
      expect(f.packet.sourceIP.toString()).toBe('10.0.0.1');
    }
  });
});

describe('la REPONSE du serveur ne se diffuse pas non plus', () => {
  it('le tiers ne recoit pas l\'Access-Accept, et le NAS si', async () => {
    const { nas, server, bystander } = await segment();
    const srv = server.getRadiusServer();
    srv.start();
    srv.setEnabled(true);
    srv.setSharedSecret('secret');
    srv.authorizeClient('10.0.0.1');
    srv.addUser('alice', 'motdepasse');

    const chezLeTiers = radiusInto(bystander);
    const reponsesAuNas = repliesInto(nas);
    server._clearArpEntry('10.0.0.1');

    askRadius(nas);

    expect(reponsesAuNas.length).toBeGreaterThan(0);
    const macDuNas = nas.getPort('GigabitEthernet0/0')!.getMAC().toString();
    for (const f of reponsesAuNas) {
      expect(f.dstMAC).toBe(macDuNas);
      expect(f.dstMAC).not.toBe(MACAddress.broadcast().toString());
    }
    expect(chezLeTiers).toEqual([]);
  });
});

describe('la duplication a disparu de radius/', () => {
  it('aucun fichier ne batit de trame ni ne retombe sur la diffusion', () => {
    const fautifs: string[] = [];
    for (const nom of ['RadiusClientAgent', 'RadiusAccountingClient', 'RadiusServerAgent',
      'CoaClient', 'CoaListener']) {
      const chemin = `src/network/radius/${nom}.ts`;
      const texte = readFileSync(chemin, 'utf8');
      if (texte.includes('MACAddress.broadcast()')) fautifs.push(`${nom}: retombee en diffusion`);
      if (texte.includes('resolveMac')) fautifs.push(`${nom}: lit encore le cache ARP`);
      if (texte.includes('resolveMac?')) fautifs.push(`${nom}: declare encore resolveMac`);
      if (texte.includes('private resolveEgress')) fautifs.push(`${nom}: resolveEgress propre`);
      if (texte.includes('etherType: ETHERTYPE_IPV4')) fautifs.push(`${nom}: batit une trame`);
    }
    expect(fautifs).toEqual([]);
  });
});
