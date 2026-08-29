/**
 * L'en-tete IPv4 s'ecrit en UN seul endroit, et les deux exceptions sont
 * NOMMEES (BRD-Modele-TCP-IP.md phase 6).
 *
 * ── Ce que la mesure a trouve ───────────────────────────────────────
 *
 * `core/packetBuilders.ts` declarait `buildIpv4Frame`, `buildUdpIpv4Frame`
 * et `wrapIpv4InEthernet`, et n'avait AUCUN appelant de production : seul
 * son propre test les appelait. Pendant ce temps DIX sites ecrivaient
 * l'en-tete IPv4 a la main — les dix champs, `headerChecksum: 0`, puis un
 * `computeIPv4Checksum` — chacun redisant les regles que `createIPv4Packet`
 * porte deja. Dix ecritures d'un meme fait ne restent pas egales.
 *
 * Le module est supprime, ses deux fonctions vivantes sont descendues dans
 * `layers/internet/InternetLayer.ts` (la brique interne de la couche), et
 * les huit sites convertissables les appellent : HSRP, VRRP, GLBP, PIM (x2),
 * VXLAN, GRE et le segment TCP.
 *
 * ── Le piege de la conversion, et c'est lui que ce fichier garde ────
 *
 * `createIPv4Packet` pose le drapeau DF par DEFAUT (`flags: 0b010`) tandis
 * que les huit sites ecrivaient tous `flags: 0`. Convertir sans passer
 * `options: { flags: 0 }` aurait donc pose DF sur toutes les annonces FHRP,
 * sur les hellos PIM, sur l'encapsulation VXLAN et GRE — en silence, et
 * aucun test existant ne l'aurait vu : aucun n'observait ce champ sur une
 * trame emise. Le cas ci-dessous l'observe SUR LE FIL.
 *
 * ── Les deux exceptions, mesurees et non supposees ──────────────────
 *
 * - **IGMP** (`igmp/frames.ts`) ecrit `ihl: 6`, parce que RFC 2236 §2 exige
 *   l'option Router Alert (RFC 2113) sur chaque message IGMP — c'est elle
 *   qui fait remonter le paquet au processus du routeur au lieu d'etre
 *   commute. `createIPv4Packet` fixe `ihl: 5` et `totalLength = 20 + n`,
 *   donc convertir ce site retirerait l'option en silence.
 * - **ICMP echo** (`icmp/IcmpEcho.ts`) DERIVE son identification de
 *   l'identifiant et du numero de sequence au lieu de bruler un
 *   `nextIPv4Id()`, ce qui la rend reproductible pour une meme sonde.
 *
 * Les deux gardent donc leur ecriture, et le cas de STRUCTURE ci-dessous
 * echoue en NOMMANT tout autre fichier qui en reintroduirait une.
 *
 * ── Discrimination ─────────────────────────────────────────────────
 *
 * TROIS cas sur six tombent contre l'etat d'avant : les deux cas de
 * structure (HEAD porte `packetBuilders.ts` et DIX fichiers ecrivant
 * l'en-tete a la main), et l'annonce VRRP observee sur le fil, verifiee
 * en reintroduisant le piege — retirer `flags: 0` de la conversion fait
 * tomber ce cas et lui seul. Les TROIS autres passent des deux cotes et
 * le doivent : le defaut DF de `buildIpv4Frame`, l'option Router Alert
 * d'IGMP et l'identification derivee de l'echo ICMP etaient deja justes,
 * et ce fichier existe pour qu'une conversion future ne les emporte pas.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { HuaweiRouter } from '@/network/devices/HuaweiRouter';
import { Cable } from '@/network/hardware/Cable';
import { resetCounters, MACAddress, IPAddress } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { IP_PROTO_VRRP } from '@/network/vrrp/types';
import { buildIgmpFrame } from '@/network/igmp/frames';
import { buildEchoRequest } from '@/network/icmp/IcmpEcho';
import { buildIpv4Frame } from '@/network/layers/internet/InternetLayer';
import { verifyIPv4Checksum, type IPv4Packet, type EthernetFrame } from '@/network/core/types';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  MACAddress.resetCounter();
  Logger.reset();
});

const NETWORK_ROOT = 'src/network';
const EXCEPTIONS = ['src/network/igmp/frames.ts', 'src/network/icmp/IcmpEcho.ts'];

function typescriptFiles(root: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(root)) {
    const path = join(root, entry);
    if (statSync(path).isDirectory()) out.push(...typescriptFiles(path));
    else if (path.endsWith('.ts')) out.push(path);
  }
  return out;
}

describe('l\'en-tete IPv4 ne se recopie plus', () => {
  it('aucun fichier hors des deux exceptions n\'ecrit un en-tete a la main', () => {
    const coupables = typescriptFiles(NETWORK_ROOT)
      .filter((path) => readFileSync(path, 'utf8').includes("type: 'ipv4', version: 4"))
      .filter((path) => !EXCEPTIONS.includes(path));
    expect(coupables).toEqual([]);
  });

  it('le module packetBuilders n\'existe plus', () => {
    const restes = typescriptFiles(NETWORK_ROOT)
      .filter((path) => path.endsWith('packetBuilders.ts'));
    expect(restes).toEqual([]);
  });
});

describe('la conversion n\'a pas pose DF', () => {
  it('une annonce VRRP part avec flags 0 et TTL 255, observe sur le fil', async () => {
    const a = new HuaweiRouter('A');
    const b = new HuaweiRouter('B');
    new Cable('s1').connect(a.getPort('GE0/0/0')!, b.getPort('GE0/0/0')!);

    const vus: IPv4Packet[] = [];
    b.getPort('GE0/0/0')!.attachTap(({ direction, frame }) => {
      if (direction !== 'in') return;
      const packet = frame.payload as IPv4Packet | undefined;
      if (packet?.type === 'ipv4' && packet.protocol === IP_PROTO_VRRP) vus.push(packet);
    });

    for (const c of ['system-view', 'interface GigabitEthernet0/0/0',
      'ip address 10.0.0.2 255.255.255.0', 'undo shutdown', 'return']) {
      await b.executeCommand(c);
    }
    for (const c of ['system-view', 'interface GigabitEthernet0/0/0',
      'ip address 10.0.0.1 255.255.255.0', 'undo shutdown',
      'vrrp vrid 1 virtual-ip 10.0.0.254', 'vrrp vrid 1 priority 200',
      'return']) await a.executeCommand(c);

    expect(vus.length).toBeGreaterThan(0);
    for (const packet of vus) {
      expect(packet.flags).toBe(0);
      expect(packet.ttl).toBe(255);
      expect(packet.tos).toBe(0xc0);
      expect(verifyIPv4Checksum(packet)).toBe(true);
    }
  });

  it('buildIpv4Frame pose DF quand personne ne demande le contraire', () => {
    const defaut = buildIpv4Frame({
      sourceIp: new IPAddress('10.0.0.1'), destinationIp: new IPAddress('10.0.0.2'),
      sourceMac: new MACAddress('00:11:22:33:44:55'),
      destinationMac: new MACAddress('00:11:22:33:44:66'),
      protocol: 112, ttl: 255, payload: null, payloadBytes: 8,
    }).payload as IPv4Packet;
    expect(defaut.flags).toBe(0b010);
  });
});

describe('les deux exceptions gardent ce qui les rend exceptionnelles', () => {
  it('IGMP porte l\'option Router Alert, que createIPv4Packet ne sait pas poser', () => {
    const frame: EthernetFrame = buildIgmpFrame(
      new MACAddress('00:11:22:33:44:55'),
      new IPAddress('10.0.0.1'),
      new IPAddress('224.0.0.1'),
      { type: 'igmp', version: 2, messageType: 'query', groupAddress: '0.0.0.0', maxRespTime: 100 },
    );
    const packet = frame.payload as IPv4Packet;
    expect(packet.ihl).toBe(6);
    expect(packet.totalLength).toBe(24 + 8);
    expect(verifyIPv4Checksum(packet)).toBe(true);
  });

  it('un echo ICMP derive son identification, il ne brule pas un compteur', () => {
    const un = buildEchoRequest('10.0.0.1', '10.0.0.2', 7, 3);
    const deux = buildEchoRequest('10.0.0.1', '10.0.0.2', 7, 3);
    const autre = buildEchoRequest('10.0.0.1', '10.0.0.2', 7, 4);
    expect(un.identification).toBe(deux.identification);
    expect(autre.identification).not.toBe(un.identification);

    const frameUn = buildIpv4Frame({
      sourceIp: new IPAddress('10.0.0.1'), destinationIp: new IPAddress('10.0.0.2'),
      sourceMac: new MACAddress('00:11:22:33:44:55'),
      destinationMac: new MACAddress('00:11:22:33:44:66'),
      protocol: 1, ttl: 64, payload: null, payloadBytes: 8,
    }).payload as IPv4Packet;
    const frameDeux = buildIpv4Frame({
      sourceIp: new IPAddress('10.0.0.1'), destinationIp: new IPAddress('10.0.0.2'),
      sourceMac: new MACAddress('00:11:22:33:44:55'),
      destinationMac: new MACAddress('00:11:22:33:44:66'),
      protocol: 1, ttl: 64, payload: null, payloadBytes: 8,
    }).payload as IPv4Packet;
    expect(frameDeux.identification).not.toBe(frameUn.identification);
  });
});
