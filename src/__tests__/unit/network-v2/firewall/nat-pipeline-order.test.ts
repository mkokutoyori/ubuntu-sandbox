/**
 * Le NAT dans le pipeline, et l'ordre qui le gouverne.
 *
 * BRD-Firewall §12.4 — la divergence la plus structurante du domaine, et
 * celle qui fait echouer la moitie des laboratoires mal concus. Elle tient
 * en cinq booleens du profil, et ce fichier verifie qu'ils produisent
 * vraiment cinq comportements et non un seul.
 *
 * VERIFIE CONTRE LA DOCUMENTATION CONSTRUCTEUR, pas de memoire :
 *
 * — PAN-OS : « Pre-NAT IP, post-NAT everything else ». La politique de
 *   securite examine les adresses ORIGINALES et les zones POST-NAT, et la
 *   traduction « n'a pas lieu tant que le paquet n'a pas quitte le
 *   pare-feu ». C'est le piege numero un du PCNSA.
 * — ASA 8.3+ : le paquet est de-NATe AVANT l'ACL, donc la regle s'ecrit
 *   avec l'adresse REELLE du serveur et non son adresse publique.
 *
 * La consequence commune aux deux, et la raison pour laquelle l'etape de
 * NAT destination precede TOUJOURS le routage : sans elle, la decision de
 * routage porterait sur l'adresse publique et designerait la mauvaise
 * interface de sortie — donc la mauvaise zone de destination, donc la
 * mauvaise regle.
 */

import { describe, it, expect } from 'vitest';
import { createCoreStages, type FirewallServices } from '@/network/devices/firewall/pipeline/stages/coreStages';
import { FirewallPipeline, PipelineStageRegistry } from '@/network/devices/firewall/pipeline/FirewallPipeline';
import { makePacketContext, type PacketContext } from '@/network/devices/firewall/pipeline/PacketContext';
import { ZoneTable } from '@/network/devices/firewall/model/ZoneTable';
import { ObjectStore } from '@/network/devices/firewall/model/ObjectStore';
import { PolicyStore } from '@/network/devices/firewall/model/PolicyStore';
import { PolicyEvaluator } from '@/network/devices/firewall/policy/PolicyEvaluator';
import { SessionTable } from '@/network/devices/firewall/session/SessionTable';
import { InterfaceTable } from '@/network/devices/firewall/l3/InterfaceTable';
import { RouteTable } from '@/network/devices/firewall/l3/RouteTable';
import { NatPolicyStore } from '@/network/devices/firewall/nat/NatPolicyStore';
import { FirewallNatEngine } from '@/network/devices/firewall/nat/FirewallNatEngine';
import { hostAddress, subnetAddress } from '@/network/devices/firewall/model/AddressObject';
import { IPAddress, IP_PROTO_TCP, type IPv4Packet, type TCPPacket } from '@/network/core/types';

const CHAIN = [
  'ingress-zone', 'session-lookup', 'tcp-state-check', 'nat-destination',
  'route-lookup', 'egress-zone', 'policy-lookup', 'nat-source', 'session-install',
];

function lab(natOrder: Partial<FirewallServices['natOrder']> = {}) {
  const interfaces = new InterfaceTable();
  interfaces.configure('port1', { ip: '192.168.1.1', mask: '255.255.255.0' });
  interfaces.configure('port2', { ip: '203.0.113.1', mask: '255.255.255.0' });
  interfaces.configure('port3', { ip: '192.168.50.1', mask: '255.255.255.0' });

  const zones = new ZoneTable();
  zones.createZone('trust'); zones.createZone('untrust'); zones.createZone('dmz');
  zones.assignInterface('trust', 'port1');
  zones.assignInterface('untrust', 'port2');
  zones.assignInterface('dmz', 'port3');

  const routes = new RouteTable({
    connectedRoutes: () => interfaces.connectedRoutes(),
    interfaceForDestination: (a) => interfaces.interfaceForDestination(a),
    isInterfaceUp: (i) => interfaces.isUp(i),
  });
  routes.addDefault('203.0.113.254');

  const objects = new ObjectStore();
  objects.addAddress(subnetAddress('LAN', '192.168.1.0', 24));
  objects.addAddress(hostAddress('SRV_WEB', '192.168.50.10'));
  objects.addAddress(hostAddress('PUB_WEB', '203.0.113.10'));

  const policy = new PolicyStore();
  const natPolicy = new NatPolicyStore();
  const sessions = new SessionTable({ now: () => 1_000_000 });
  const nat = new FirewallNatEngine({
    objects, policy: natPolicy,
    interfaceAddress: (iface) => interfaces.get(iface)?.ip,
  });

  const services: FirewallServices = {
    zones, interfaces, routes, objects, policy, natPolicy, nat,
    evaluator: new PolicyEvaluator({ objects }),
    sessions, now: () => 1_000_000,
    natOrder: {
      policySeesPreNatSource: true,
      policySeesPreNatDestination: true,
      ...natOrder,
    },
  };

  const registry = new PipelineStageRegistry();
  for (const stage of createCoreStages(services)) registry.register(stage);
  return {
    services, policy, natPolicy, sessions, nat,
    pipeline: FirewallPipeline.fromStageNames(CHAIN, registry),
  };
}

function tcp(src: string, dst: string, sport = 54321, dport = 80): IPv4Packet {
  const segment: TCPPacket = {
    type: 'tcp', sourcePort: sport, destinationPort: dport,
    sequenceNumber: 0, acknowledgementNumber: 0,
    flags: { syn: true, ack: false, fin: false, rst: false, psh: false, urg: false },
    windowSize: 65535, checksum: 0, payload: null,
  } as TCPPacket;
  return {
    type: 'ipv4', version: 4, ihl: 5, tos: 0, totalLength: 60,
    identification: 1, flags: 0, fragmentOffset: 0, ttl: 64,
    protocol: IP_PROTO_TCP, headerChecksum: 0,
    sourceIP: new IPAddress(src), destinationIP: new IPAddress(dst),
    payload: segment,
  } as IPv4Packet;
}

function ctx(port: string, packet: IPv4Packet): PacketContext {
  return makePacketContext({ ingressPort: port, packet, arrivedAt: 1000 });
}

function publishWeb(natPolicy: NatPolicyStore) {
  natPolicy.append({
    id: 'D1', type: 'static', fromZone: ['untrust'], toZone: ['any'],
    originalDestination: ['PUB_WEB'],
    destinationTranslation: { kind: 'static-ip', translatedAddress: '192.168.50.10' },
  });
}

describe('NAT destination — decide AVANT le routage', () => {
  it('la traduction change l\'interface de sortie choisie', () => {
    const { pipeline, policy, natPolicy } = lab();
    publishWeb(natPolicy);
    policy.append({ id: 'R1', from: ['untrust'], to: ['dmz'], action: 'allow' });

    const c = ctx('port2', tcp('198.51.100.7', '203.0.113.10'));
    pipeline.process(c);

    expect(c.egressPort).toBe('port3');
    expect(c.egressZone).toBe('dmz');
  });

  it('SANS traduction, la meme destination sort par une autre interface', () => {
    const { pipeline, policy } = lab();
    policy.append({ id: 'R1', from: ['untrust'], to: ['untrust'], action: 'allow' });

    const c = ctx('port2', tcp('198.51.100.7', '203.0.113.10'));
    pipeline.process(c);

    expect(c.egressPort).toBe('port2');
  });

  it('le paquet transmis porte l\'adresse REELLE du serveur', () => {
    const { pipeline, policy, natPolicy } = lab();
    publishWeb(natPolicy);
    policy.append({ id: 'R1', from: ['untrust'], to: ['dmz'], action: 'allow' });

    const outcome = pipeline.process(ctx('port2', tcp('198.51.100.7', '203.0.113.10')));

    expect(outcome.verdict).toBe('accepted');
    expect((outcome.payload!.packet as IPv4Packet).destinationIP.toString()).toBe('192.168.50.10');
  });

  it('`originalPacket` garde l\'adresse PUBLIQUE, intacte', () => {
    const { pipeline, policy, natPolicy } = lab();
    publishWeb(natPolicy);
    policy.append({ id: 'R1', from: ['untrust'], to: ['dmz'], action: 'allow' });

    const c = ctx('port2', tcp('198.51.100.7', '203.0.113.10'));
    pipeline.process(c);

    expect((c.originalPacket as IPv4Packet).destinationIP.toString()).toBe('203.0.113.10');
    expect((c.packet as IPv4Packet).destinationIP.toString()).toBe('192.168.50.10');
  });
});

describe('§12.4 — la politique voit PRE-NAT ou POST-NAT selon le profil', () => {
  it('PAN-OS : la regle s\'ecrit avec l\'adresse PUBLIQUE — pre-NAT', () => {
    const { pipeline, policy, natPolicy } = lab({ policySeesPreNatDestination: true });
    publishWeb(natPolicy);
    policy.append({
      id: 'R1', from: ['untrust'], to: ['dmz'], destination: ['PUB_WEB'], action: 'allow',
    });

    expect(pipeline.process(ctx('port2', tcp('198.51.100.7', '203.0.113.10'))).verdict)
      .toBe('accepted');
  });

  it('PAN-OS : la meme regle ecrite avec l\'adresse REELLE ne correspond PAS', () => {
    const { pipeline, policy, natPolicy } = lab({ policySeesPreNatDestination: true });
    publishWeb(natPolicy);
    policy.append({
      id: 'R1', from: ['untrust'], to: ['dmz'], destination: ['SRV_WEB'], action: 'allow',
    });

    expect(pipeline.process(ctx('port2', tcp('198.51.100.7', '203.0.113.10'))).verdict)
      .toBe('dropped');
  });

  it('ASA 8.3+ : la regle s\'ecrit avec l\'adresse REELLE — post-de-NAT', () => {
    const { pipeline, policy, natPolicy } = lab({ policySeesPreNatDestination: false });
    publishWeb(natPolicy);
    policy.append({
      id: 'R1', from: ['untrust'], to: ['dmz'], destination: ['SRV_WEB'], action: 'allow',
    });

    expect(pipeline.process(ctx('port2', tcp('198.51.100.7', '203.0.113.10'))).verdict)
      .toBe('accepted');
  });

  it('ASA 8.3+ : la meme regle ecrite avec l\'adresse PUBLIQUE ne correspond PAS', () => {
    const { pipeline, policy, natPolicy } = lab({ policySeesPreNatDestination: false });
    publishWeb(natPolicy);
    policy.append({
      id: 'R1', from: ['untrust'], to: ['dmz'], destination: ['PUB_WEB'], action: 'allow',
    });

    expect(pipeline.process(ctx('port2', tcp('198.51.100.7', '203.0.113.10'))).verdict)
      .toBe('dropped');
  });

  it('DEUX profils, DEUX verdicts, sur la MEME regle et le MEME paquet', () => {
    function verdictFor(preNat: boolean) {
      const { pipeline, policy, natPolicy } = lab({ policySeesPreNatDestination: preNat });
      publishWeb(natPolicy);
      policy.append({
        id: 'R1', from: ['untrust'], to: ['dmz'], destination: ['PUB_WEB'], action: 'allow',
      });
      return pipeline.process(ctx('port2', tcp('198.51.100.7', '203.0.113.10'))).verdict;
    }

    expect(verdictFor(true)).toBe('accepted');
    expect(verdictFor(false)).toBe('dropped');
  });

  it('dans les DEUX cas la zone de destination est POST-NAT', () => {
    for (const preNat of [true, false]) {
      const { pipeline, policy, natPolicy } = lab({ policySeesPreNatDestination: preNat });
      publishWeb(natPolicy);
      policy.append({ id: 'R1', from: ['untrust'], to: ['dmz'], action: 'allow' });

      const c = ctx('port2', tcp('198.51.100.7', '203.0.113.10'));
      pipeline.process(c);

      expect(c.egressZone).toBe('dmz');
    }
  });
});

describe('NAT source — applique APRES la politique', () => {
  function withPat(l: ReturnType<typeof lab>) {
    l.natPolicy.append({
      id: 'S1', type: 'dynamic-pat', fromZone: ['trust'], toZone: ['untrust'],
      originalSource: ['LAN'], sourceTranslation: { kind: 'interface-address' },
    });
    l.policy.append({ id: 'R1', from: ['trust'], to: ['untrust'], action: 'allow' });
    return l;
  }

  it('le paquet transmis porte l\'adresse de l\'interface de sortie', () => {
    const l = withPat(lab());

    const outcome = l.pipeline.process(ctx('port1', tcp('192.168.1.10', '198.51.100.9')));

    expect((outcome.payload!.packet as IPv4Packet).sourceIP.toString()).toBe('203.0.113.1');
  });

  it('la politique a vu l\'adresse PRIVEE — la regle s\'ecrit avec elle', () => {
    const l = lab();
    l.natPolicy.append({
      id: 'S1', type: 'dynamic-pat', fromZone: ['trust'], toZone: ['untrust'],
      originalSource: ['LAN'], sourceTranslation: { kind: 'interface-address' },
    });
    l.policy.append({
      id: 'R1', from: ['trust'], to: ['untrust'], source: ['LAN'], action: 'allow',
    });

    expect(l.pipeline.process(ctx('port1', tcp('192.168.1.10', '198.51.100.9'))).verdict)
      .toBe('accepted');
  });

  it('la traduction est MEMORISEE sur la session', () => {
    const l = withPat(lab());

    l.pipeline.process(ctx('port1', tcp('192.168.1.10', '198.51.100.9')));

    const session = l.sessions.view().all()[0];
    expect(session.translation?.translatedSource).toBe('203.0.113.1');
    expect(session.natRuleId).toBe('S1');
  });

  it('un flux REFUSE n\'alloue aucune traduction', () => {
    const l = lab();
    l.natPolicy.append({
      id: 'S1', type: 'dynamic-pat', fromZone: ['trust'], toZone: ['untrust'],
      originalSource: ['LAN'], sourceTranslation: { kind: 'interface-address' },
    });

    l.pipeline.process(ctx('port1', tcp('192.168.1.10', '198.51.100.9')));

    expect(l.nat.statistics().translationsCreated).toBe(0);
  });

  it('sans regle NAT, le paquet sort avec son adresse d\'origine', () => {
    const l = lab();
    l.policy.append({ id: 'R1', from: ['trust'], to: ['untrust'], action: 'allow' });

    const outcome = l.pipeline.process(ctx('port1', tcp('192.168.1.10', '198.51.100.9')));

    expect((outcome.payload!.packet as IPv4Packet).sourceIP.toString()).toBe('192.168.1.10');
  });
});
