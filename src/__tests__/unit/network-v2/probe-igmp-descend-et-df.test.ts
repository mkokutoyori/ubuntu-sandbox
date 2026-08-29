/**
 * IGMP descend par la couche internet, et son DF est celui qu'une vraie
 * machine pose (BRD §3.3, phase 7).
 *
 * ── Le defaut, trouve en changeant de source d'autorite ─────────────
 *
 * Le simulateur ecrivait `flags: 0` — DF CLAIR — sur chaque message
 * IGMP. Ce n'est pas une RFC qui le contredit : la RFC 2236 §2 exige
 * l'option Router Alert et ne dit rien de DF. C'est l'IMPLANTATION
 * retenue qui tranche, et le noyau Linux pose DF sur les DEUX chemins
 * IGMP (`net/ipv4/igmp.c`, chemins rapport et requete) :
 *
 *     iph->ihl      = (sizeof(struct iphdr)+4)>>2;   // = 6
 *     iph->tos      = 0xc0;
 *     iph->frag_off = htons(IP_DF);                  // DF POSE
 *     iph->ttl      = 1;
 *     ((u8 *)&iph[1])[0] = IPOPT_RA;                 // Router Alert, len 4
 *
 * Le simulateur etait donc juste sur IHL 6, TOS 0xc0 et TTL 1, et FAUX
 * sur DF. Un apprenant comparant sa capture a celle d'une vraie machine
 * aurait lu « Don't fragment: Not set » la ou le noyau ecrit « Set ».
 *
 * ── La descente, et la limite qu'elle a levee ───────────────────────
 *
 * IGMP etait le dernier moteur a batir sa propre trame, et il ne POUVAIT
 * pas descendre : `createIPv4Packet` fixait `ihl: 5` et
 * `totalLength = 20 + n`, donc l'y forcer aurait retire l'option Router
 * Alert en silence. `IPv4HeaderOptions.headerBytes` exprime desormais
 * l'en-tete a options — `ihl` et `totalLength` en DERIVENT, et
 * `ipv4HeaderProblem` les valide deja, donc ce n'est pas un champ inerte.
 *
 * `buildIgmpFrame` devient `igmpSendRequest` : les TROIS emetteurs — la
 * requete du routeur, le rapport de l'hote, le querier de snooping du
 * commutateur — partagent une seule description du paquet.
 *
 * Le querier de snooping garde deliberement son propre `sendOnLink` :
 * il emet PORT PAR PORT sur un VLAN, ce qui est une decision de couche
 * lien qu'il prend deja, et la faire passer par `sendFrame` lui ferait
 * perdre l'etiquetage que la couche lien applique. Seule la construction
 * du PAQUET descend.
 *
 * ── Discrimination ─────────────────────────────────────────────────
 *
 * QUATRE cas sur six tombent contre l'etat d'avant : les trois DF (un
 * par emetteur) et le cas de STRUCTURE. Les deux autres passent des deux
 * cotes et le doivent — l'option Router Alert et le TTL etaient DEJA
 * justes, et ce fichier existe pour qu'une descente future ne les
 * emporte pas.
 *
 * Deux choses apprises en l'ecrivant, ecrites plutot que tues. (1) La
 * premiere version du cas du QUERIER etait VACUE : elle appelait un
 * `forceQuerierTick?.()` qui n'existe pas, et un `if (length === 0)
 * return` cachait qu'aucune trame n'etait jamais observee — le cas
 * passait des deux cotes en ne prouvant rien. Il monte desormais son
 * laboratoire par la CLI (VLAN, port d'acces, SVI), demarre l'agent et
 * AVANCE une horloge virtuelle, ce qui en fait le premier test du depot
 * a declencher ce querier. (2) Le rapport de l'hote est adresse au
 * GROUPE (239.1.1.1), c'est-a-dire du multicast ROUTABLE : l'offre le
 * confiait a la table de routage unicast, qui n'a rien pour lui. Un
 * multicast ne se route jamais par la RIB unicast — il s'emet sur
 * l'interface nommee — et `requiresNamedInterface` couvre desormais tout
 * ce qui n'est pas unicast.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { CiscoSwitch } from '@/network/devices/CiscoSwitch';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { Cable } from '@/network/hardware/Cable';
import {
  resetCounters, MACAddress, IPAddress, SubnetMask,
  verifyIPv4Checksum, type IPv4Packet,
} from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { IP_PROTO_IGMP } from '@/network/igmp/types';
import { VirtualTimeScheduler, __setDefaultScheduler } from '@/events/Scheduler';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  MACAddress.resetCounter();
  Logger.reset();
});

const DF = 0b010;

function igmpOut(device: { getPorts(): Array<{ attachTap(t: (f: {
  direction: string; frame: { dstMAC: { toString(): string }; payload: unknown };
}) => void): unknown }> }): Array<{ dstMAC: string; packet: IPv4Packet }> {
  const seen: Array<{ dstMAC: string; packet: IPv4Packet }> = [];
  for (const p of device.getPorts()) {
    p.attachTap(({ direction, frame }) => {
      if (direction !== 'out') return;
      const packet = frame.payload as IPv4Packet | undefined;
      if (packet?.type === 'ipv4' && packet.protocol === IP_PROTO_IGMP) {
        seen.push({ dstMAC: frame.dstMAC.toString(), packet });
      }
    });
  }
  return seen;
}

function attendu(vus: Array<{ dstMAC: string; packet: IPv4Packet }>): void {
  expect(vus.length).toBeGreaterThan(0);
  for (const { packet } of vus) {
    expect(packet.flags).toBe(DF);
    expect(packet.ihl).toBe(6);
    expect(packet.totalLength).toBe(24 + 8);
    expect(packet.tos).toBe(0xc0);
    expect(packet.ttl).toBe(1);
    expect(verifyIPv4Checksum(packet)).toBe(true);
  }
}

describe('les trois emetteurs posent DF, comme le noyau', () => {
  it('la requete du ROUTEUR', async () => {
    const r = new CiscoRouter('R1');
    const sw = new CiscoSwitch('switch-cisco', 'SW', 4);
    new Cable('c1').connect(r.getPort('GigabitEthernet0/0')!, sw.getPort('FastEthernet0/1')!);
    r.getPort('GigabitEthernet0/0')!
      .configureIP(new IPAddress('10.0.0.1'), new SubnetMask('255.255.255.0'));
    for (const c of ['enable', 'configure terminal', 'interface GigabitEthernet0/0',
      'no shutdown', 'end']) await r.executeCommand(c);

    const vus = igmpOut(r);
    r.getIgmpAgent().enableInterface('GigabitEthernet0/0', 2);
    attendu(vus);
  });

  it('le rapport de l\'HOTE', () => {
    const pc = new LinuxPC('PC');
    const sw = new CiscoSwitch('switch-cisco', 'SW', 4);
    new Cable('c1').connect(pc.getPorts()[0], sw.getPort('FastEthernet0/1')!);
    pc.getPorts()[0].configureIP(new IPAddress('10.0.0.10'), new SubnetMask('255.255.255.0'));

    const vus = igmpOut(pc);
    pc.getIgmpHostAgent().join(pc.getPorts()[0].getName(), '239.1.1.1');
    attendu(vus);
  });

  it('le querier de SNOOPING du commutateur, quand son minuteur tombe', async () => {
    const clock = new VirtualTimeScheduler();
    __setDefaultScheduler(clock);
    try {
      const sw = new CiscoSwitch('switch-cisco', 'SW', 4);
      const pc = new LinuxPC('PC');
      new Cable('c1').connect(pc.getPorts()[0], sw.getPort('FastEthernet0/1')!);
      for (const c of ['enable', 'configure terminal', 'vlan 10', 'name DATA', 'exit',
        'interface FastEthernet0/1', 'switchport mode access', 'switchport access vlan 10',
        'no shutdown', 'exit', 'interface Vlan10',
        'ip address 10.0.0.1 255.255.255.0', 'no shutdown', 'end']) {
        await sw.executeCommand(c);
      }

      const vus = igmpOut(sw);
      const agent = sw.getIgmpSnoopingAgent();
      agent.start();
      agent.setEnabled(true);
      agent.setQuerierEnabled(10, true);
      clock.advance(2000);

      attendu(vus);
    } finally {
      __setDefaultScheduler(null);
    }
  });
});

describe('l\'option Router Alert et le TTL survivent a la descente', () => {
  it('la requete du routeur porte toujours IHL 6, 32 octets et TTL 1', async () => {
    const r = new CiscoRouter('R1');
    const sw = new CiscoSwitch('switch-cisco', 'SW', 4);
    new Cable('c1').connect(r.getPort('GigabitEthernet0/0')!, sw.getPort('FastEthernet0/1')!);
    r.getPort('GigabitEthernet0/0')!
      .configureIP(new IPAddress('10.0.0.1'), new SubnetMask('255.255.255.0'));
    for (const c of ['enable', 'configure terminal', 'interface GigabitEthernet0/0',
      'no shutdown', 'end']) await r.executeCommand(c);

    const vus = igmpOut(r);
    r.getIgmpAgent().enableInterface('GigabitEthernet0/0', 2);
    expect(vus.length).toBeGreaterThan(0);
    for (const { packet, dstMAC } of vus) {
      expect(packet.ihl).toBe(6);
      expect(packet.totalLength).toBe(32);
      expect(packet.ttl).toBe(1);
      expect(dstMAC.startsWith('01:00:5e:')).toBe(true);
    }
  });

  it('un en-tete SANS option reste a IHL 5 et 20 octets', async () => {
    const r = new CiscoRouter('R1');
    const sw = new CiscoSwitch('switch-cisco', 'SW', 4);
    new Cable('c1').connect(r.getPort('GigabitEthernet0/0')!, sw.getPort('FastEthernet0/1')!);
    r.getPort('GigabitEthernet0/0')!
      .configureIP(new IPAddress('10.0.0.1'), new SubnetMask('255.255.255.0'));
    for (const c of ['enable', 'configure terminal', 'interface GigabitEthernet0/0',
      'no shutdown', 'vrrp 1 ip 10.0.0.254', 'end']) await r.executeCommand(c);

    const vrrp: IPv4Packet[] = [];
    r.getPort('GigabitEthernet0/0')!.attachTap(({ direction, frame }) => {
      if (direction !== 'out') return;
      const packet = frame.payload as IPv4Packet | undefined;
      if (packet?.type === 'ipv4' && packet.protocol === 112) vrrp.push(packet);
    });
    for (const c of ['enable', 'configure terminal', 'interface GigabitEthernet0/0',
      'vrrp 1 priority 200', 'end']) await r.executeCommand(c);

    expect(vrrp.length).toBeGreaterThan(0);
    for (const packet of vrrp) {
      expect(packet.ihl).toBe(5);
      expect(packet.ihl * 4).toBe(20);
      expect(packet.totalLength - packet.ihl * 4).toBe(12);
    }
  });
});

describe('IGMP ne batit plus sa trame', () => {
  it('frames.ts decrit une requete, il n\'assemble plus d\'Ethernet', () => {
    const texte = readFileSync('src/network/igmp/frames.ts', 'utf8');
    const fautes: string[] = [];
    if (texte.includes('buildIgmpFrame')) fautes.push('buildIgmpFrame subsiste');
    if (texte.includes('ETHERTYPE_IPV4')) fautes.push('assemble encore une trame');
    if (texte.includes('computeIPv4Checksum')) fautes.push('calcule encore la somme');
    if (!texte.includes('igmpSendRequest')) fautes.push('igmpSendRequest absent');
    expect(fautes).toEqual([]);
  });
});
