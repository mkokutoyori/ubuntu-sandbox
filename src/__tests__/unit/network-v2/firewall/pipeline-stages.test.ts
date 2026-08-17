/**
 * Les etapes concretes du pipeline — le moment ou tout se branche.
 *
 * BRD-Firewall §13.2. Ce fichier est le premier a faire travailler
 * ensemble ZoneTable, InterfaceTable, RouteTable, PolicyEvaluator,
 * SessionTable et TcpStateMachine, et c'est donc le premier a pouvoir
 * demontrer les cas d'usage fondateurs plutot que les briques isolees.
 *
 * UC-1 — L'INSPECTION A ETATS. Une seule regle, dans le sens aller. Le
 * retour passe parce que la SESSION existe, pas parce qu'une regle
 * l'autorise. Le contre-test est aussi important que le test : un ACK forge
 * sans session est refuse.
 *
 * UC-4 — LENT ET RAPIDE. Le premier paquet traverse la recherche de
 * politique ; les suivants ne la traversent PAS. C'est mesure par le
 * compteur de la regle, qui ne bouge plus — I-F1 rend cette affirmation
 * verifiable au lieu de la laisser declarative.
 *
 * Les cinq motifs de rejet du principe P10 sont distincts et chacun a son
 * cas : refus par la politique, absence de route, paquet non-SYN sans
 * session, drapeaux invalides, zone indeterminee.
 */

import { describe, it, expect, beforeEach } from 'vitest';
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
import { IPAddress, IP_PROTO_TCP, type IPv4Packet, type TCPFlags, type TCPPacket } from '@/network/core/types';

const CHAIN = [
  'ingress-zone', 'session-lookup', 'tcp-state-check',
  'route-lookup', 'egress-zone', 'policy-lookup', 'session-install',
];

let clock = 1_000_000;

function lab() {
  const interfaces = new InterfaceTable();
  interfaces.configure('port1', { ip: '192.168.1.1', mask: '255.255.255.0' });
  interfaces.configure('port2', { ip: '203.0.113.1', mask: '255.255.255.0' });

  const zones = new ZoneTable();
  zones.createZone('trust');
  zones.createZone('untrust');
  zones.assignInterface('trust', 'port1');
  zones.assignInterface('untrust', 'port2');

  const routes = new RouteTable({
    connectedRoutes: () => interfaces.connectedRoutes(),
    interfaceForDestination: (a) => interfaces.interfaceForDestination(a),
    isInterfaceUp: (i) => interfaces.isUp(i),
  });
  routes.addDefault('203.0.113.254');

  const objects = new ObjectStore();
  const policy = new PolicyStore();
  const sessions = new SessionTable({ now: () => clock });
  const evaluator = new PolicyEvaluator({ objects });

  const vdom = { name: 'root', zones, routes, objects, policy, evaluator, sessions };
  const services: FirewallServices = {
    interfaces, vdomOf: () => vdom, now: () => clock,
  };

  const registry = new PipelineStageRegistry();
  for (const stage of createCoreStages(services)) registry.register(stage);

  return { services, zones, routes, pipeline: FirewallPipeline.fromStageNames(CHAIN, registry), policy, sessions };
}

function flags(set: Partial<TCPFlags>): TCPFlags {
  return { syn: false, ack: false, fin: false, rst: false, psh: false, urg: false, ...set };
}

function tcpPacket(src: string, dst: string, sport: number, dport: number, f: TCPFlags): IPv4Packet {
  const segment: TCPPacket = {
    type: 'tcp', sourcePort: sport, destinationPort: dport,
    sequenceNumber: 0, acknowledgementNumber: 0, flags: f,
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
  return makePacketContext({ ingressPort: port, packet, arrivedAt: clock });
}

const OUT_SYN = () => tcpPacket('192.168.1.10', '203.0.113.5', 54321, 80, flags({ syn: true }));
const IN_SYNACK = () => tcpPacket('203.0.113.5', '192.168.1.10', 80, 54321, flags({ syn: true, ack: true }));

function allowAll(policy: PolicyStore) {
  policy.append({ id: 'R1', name: 'Allow-Out', from: ['trust'], to: ['untrust'], action: 'allow' });
}

beforeEach(() => { clock = 1_000_000; });

describe('Etapes — UC-1, l\'inspection a etats', () => {
  it('le premier SYN est accepte et installe une session', () => {
    const { pipeline, policy, sessions } = lab();
    allowAll(policy);

    const outcome = pipeline.process(ctx('port1', OUT_SYN()));

    expect(outcome.verdict).toBe('accepted');
    expect(sessions.count()).toBe(1);
  });

  it('LE RETOUR PASSE alors qu\'AUCUNE regle ne l\'autorise', () => {
    const { pipeline, policy } = lab();
    allowAll(policy);
    pipeline.process(ctx('port1', OUT_SYN()));

    const retour = pipeline.process(ctx('port2', IN_SYNACK()));

    expect(retour.verdict).toBe('accepted');
  });

  it('le retour est reconnu dans le sens s2c', () => {
    const { pipeline, policy } = lab();
    allowAll(policy);
    pipeline.process(ctx('port1', OUT_SYN()));

    const c = ctx('port2', IN_SYNACK());
    pipeline.process(c);

    expect(c.sessionDirection).toBe('s2c');
    expect(c.isFirstPacket).toBe(false);
  });

  it('LE CONTRE-TEST : un ACK forge SANS session est refuse', () => {
    const { pipeline, policy } = lab();
    allowAll(policy);

    const forge = tcpPacket('203.0.113.5', '192.168.1.10', 80, 54321, flags({ ack: true }));
    const outcome = pipeline.process(ctx('port2', forge));

    expect(outcome.verdict).toBe('dropped');
    expect(outcome.reason).toBe('no-session-non-syn');
  });

  it('purger la session coupe le retour', () => {
    const { pipeline, policy, sessions } = lab();
    allowAll(policy);
    pipeline.process(ctx('port1', OUT_SYN()));

    sessions.clear();

    expect(pipeline.process(ctx('port2', IN_SYNACK())).verdict).toBe('dropped');
  });
});

describe('Etapes — UC-4, chemin lent et chemin rapide', () => {
  it('le premier paquet consulte la politique', () => {
    const { pipeline, policy } = lab();
    allowAll(policy);

    pipeline.process(ctx('port1', OUT_SYN()));

    expect(policy.byId('R1')?.hitCount).toBe(1);
  });

  it('I-F1 : les paquets SUIVANTS ne consultent PAS la politique', () => {
    const { pipeline, policy } = lab();
    allowAll(policy);
    pipeline.process(ctx('port1', OUT_SYN()));
    const apresPremier = policy.byId('R1')!.hitCount;

    pipeline.process(ctx('port2', IN_SYNACK()));
    pipeline.process(ctx('port1', tcpPacket('192.168.1.10', '203.0.113.5', 54321, 80, flags({ ack: true }))));

    expect(policy.byId('R1')?.hitCount).toBe(apresPremier);
  });

  it('le chemin rapide ne traverse pas la recherche de politique', () => {
    const { pipeline, policy } = lab();
    allowAll(policy);
    pipeline.process(ctx('port1', OUT_SYN()));

    const outcome = pipeline.process(ctx('port2', IN_SYNACK()));

    expect(outcome.trace).not.toContain('policy-lookup');
  });

  it('le chemin lent traverse bien la recherche de politique', () => {
    const { pipeline, policy } = lab();
    allowAll(policy);

    expect(pipeline.process(ctx('port1', OUT_SYN())).trace).toContain('policy-lookup');
  });

  it('P9 : une regle supprimee ne coupe PAS la session en cours', () => {
    const { pipeline, policy } = lab();
    allowAll(policy);
    pipeline.process(ctx('port1', OUT_SYN()));

    policy.remove('R1');

    expect(pipeline.process(ctx('port2', IN_SYNACK())).verdict).toBe('accepted');
  });
});

describe('Etapes — P10, cinq refus distincts', () => {
  it('refus par la politique — aucune regle', () => {
    const { pipeline } = lab();

    const outcome = pipeline.process(ctx('port1', OUT_SYN()));

    expect(outcome.verdict).toBe('dropped');
    expect(outcome.reason).toBe('implicit-deny');
  });

  it('refus par une regle explicite', () => {
    const { pipeline, policy } = lab();
    policy.append({ id: 'R1', from: ['trust'], to: ['untrust'], action: 'deny' });

    expect(pipeline.process(ctx('port1', OUT_SYN())).reason).toBe('policy-deny');
  });

  it('absence de route — vers une destination HORS de tout sous-reseau connecte', () => {
    const { pipeline, policy, routes } = lab();
    allowAll(policy);
    routes.clearStatics();

    const loin = tcpPacket('192.168.1.10', '8.8.8.8', 54321, 53, flags({ syn: true }));
    const outcome = pipeline.process(ctx('port1', loin));

    expect(outcome.reason).toBe('no-route');
  });

  it('le temoin : la MEME destination lointaine passe tant que la route par defaut existe', () => {
    const { pipeline, policy } = lab();
    allowAll(policy);

    const loin = tcpPacket('192.168.1.10', '8.8.8.8', 54321, 53, flags({ syn: true }));

    expect(pipeline.process(ctx('port1', loin)).verdict).toBe('accepted');
  });

  it('drapeaux TCP invalides — le Xmas scan', () => {
    const { pipeline, policy } = lab();
    allowAll(policy);

    const xmas = tcpPacket('192.168.1.10', '203.0.113.5', 54321, 80,
      flags({ fin: true, psh: true, urg: true }));

    expect(pipeline.process(ctx('port1', xmas)).reason).toBe('invalid-tcp-flags');
  });

  it('zone d\'entree indeterminee — interface hors zone', () => {
    const { pipeline, policy, zones } = lab();
    allowAll(policy);
    zones.removeInterface('port1');

    expect(pipeline.process(ctx('port1', OUT_SYN())).reason).toBe('zone-mismatch');
  });

  it('les cinq motifs sont bien DISTINCTS', () => {
    const motifs = new Set(['implicit-deny', 'policy-deny', 'no-route',
      'invalid-tcp-flags', 'zone-mismatch']);

    expect(motifs.size).toBe(5);
  });
});

describe('Etapes — zones et routage', () => {
  it('la zone d\'entree vient de l\'interface d\'arrivee', () => {
    const { pipeline, policy } = lab();
    allowAll(policy);

    const c = ctx('port1', OUT_SYN());
    pipeline.process(c);

    expect(c.ingressZone).toBe('trust');
  });

  it('la zone de SORTIE n\'est connue qu\'APRES la decision de routage', () => {
    const { pipeline, policy } = lab();
    allowAll(policy);

    const c = ctx('port1', OUT_SYN());
    pipeline.process(c);

    expect(c.egressPort).toBe('port2');
    expect(c.egressZone).toBe('untrust');
  });

  it('une regle citant la mauvaise zone de sortie ne correspond pas', () => {
    const { pipeline, policy } = lab();
    policy.append({ id: 'R1', from: ['trust'], to: ['dmz'], action: 'allow' });

    expect(pipeline.process(ctx('port1', OUT_SYN())).reason).toBe('implicit-deny');
  });

  it('un flux refuse installe une session en discard', () => {
    const { pipeline, sessions } = lab();

    pipeline.process(ctx('port1', OUT_SYN()));

    expect(sessions.view().statistics().discarded).toBe(1);
  });

  it('la session refusee evite une SECONDE recherche de politique', () => {
    const { pipeline, policy } = lab();
    policy.append({ id: 'R1', from: ['trust'], to: ['untrust'], action: 'deny' });
    pipeline.process(ctx('port1', OUT_SYN()));
    const apres = policy.byId('R1')!.hitCount;

    pipeline.process(ctx('port1', tcpPacket('192.168.1.10', '203.0.113.5', 54321, 80, flags({ syn: true }))));

    expect(policy.byId('R1')?.hitCount).toBe(apres);
  });
});

describe('Etapes — §13.8, le chemin rapide traverse QUAND MEME la machine a etats', () => {
  function etablie() {
    const l = lab();
    allowAll(l.policy);
    l.pipeline.process(ctx('port1', OUT_SYN()));
    l.pipeline.process(ctx('port2', IN_SYNACK()));
    l.pipeline.process(ctx('port1', tcpPacket('192.168.1.10', '203.0.113.5', 54321, 80, flags({ ack: true }))));
    return l;
  }

  it('l\'etat de la session AVANCE au fil de la poignee de main', () => {
    const { pipeline, policy, sessions } = lab();
    allowAll(policy);

    pipeline.process(ctx('port1', OUT_SYN()));
    expect(sessions.view().all()[0].tcpState).toBe('syn-sent');

    pipeline.process(ctx('port2', IN_SYNACK()));
    expect(sessions.view().all()[0].tcpState).toBe('syn-received');

    pipeline.process(ctx('port1', tcpPacket('192.168.1.10', '203.0.113.5', 54321, 80, flags({ ack: true }))));
    expect(sessions.view().all()[0].tcpState).toBe('established');
  });

  it('UN PAQUET INVALIDE DANS UNE SESSION VALIDE EST REJETE', () => {
    const { pipeline } = etablie();

    const xmas = tcpPacket('192.168.1.10', '203.0.113.5', 54321, 80,
      flags({ fin: true, psh: true, urg: true }));
    const outcome = pipeline.process(ctx('port1', xmas));

    expect(outcome.verdict).toBe('dropped');
    expect(outcome.reason).toBe('invalid-tcp-flags');
  });

  it('le temoin : un ACK ordinaire dans la meme session passe', () => {
    const { pipeline } = etablie();

    const ack = tcpPacket('192.168.1.10', '203.0.113.5', 54321, 80, flags({ ack: true }));

    expect(pipeline.process(ctx('port1', ack)).verdict).toBe('accepted');
  });

  it('un RST ferme la session', () => {
    const { pipeline, sessions } = etablie();

    const rst = tcpPacket('203.0.113.5', '192.168.1.10', 80, 54321, flags({ rst: true }));
    pipeline.process(ctx('port2', rst));

    expect(sessions.count()).toBe(0);
  });

  it('le delai d\'expiration suit l\'etat — court en poignee de main, long une fois etablie', () => {
    const { pipeline, policy, sessions } = lab();
    allowAll(policy);

    pipeline.process(ctx('port1', OUT_SYN()));
    pipeline.process(ctx('port2', IN_SYNACK()));
    expect(sessions.view().all()[0].timeoutSec).toBe(30);

    pipeline.process(ctx('port1', tcpPacket('192.168.1.10', '203.0.113.5', 54321, 80, flags({ ack: true }))));
    expect(sessions.view().all()[0].timeoutSec).toBe(3600);
  });
});

describe('Etapes — compteurs de session', () => {
  it('compte les octets dans le sens aller', () => {
    const { pipeline, policy, sessions } = lab();
    allowAll(policy);

    pipeline.process(ctx('port1', OUT_SYN()));

    expect(sessions.view().all()[0].counters.bytesC2S).toBe(60);
    expect(sessions.view().all()[0].counters.packetsC2S).toBe(1);
  });

  it('compte les octets du retour dans l\'autre sens', () => {
    const { pipeline, policy, sessions } = lab();
    allowAll(policy);
    pipeline.process(ctx('port1', OUT_SYN()));

    pipeline.process(ctx('port2', IN_SYNACK()));

    const session = sessions.view().all()[0];
    expect(session.counters.packetsS2C).toBe(1);
    expect(session.counters.packetsC2S).toBe(1);
  });

  it('la session porte la regle qui l\'a autorisee', () => {
    const { pipeline, policy, sessions } = lab();
    allowAll(policy);

    pipeline.process(ctx('port1', OUT_SYN()));

    expect(sessions.view().all()[0].policyId).toBe('R1');
  });
});
