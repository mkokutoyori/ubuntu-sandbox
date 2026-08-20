/**
 * `FlowKey` — l'objet-valeur qui indexe la table de sessions du pare-feu.
 *
 * BRD-Firewall §10.2 : la table est indexée par FLUX DIRECTIONNEL et non
 * par session, deux entrées d'index pointant vers un même objet session.
 * C'est ce qui permet de répondre en O(1) à « ce paquet appartient-il à un
 * flux connu, et dans quel sens ? » — la question du chemin rapide.
 *
 * Le piège que ces cas fixent est qu'un flux N'EST PAS toujours symétrique
 * par échange des ports :
 *
 * — TCP et UDP le sont : le retour de (A:1234 → B:80) est (B:80 → A:1234).
 * — ICMP ne l'est pas. Une réponse d'écho porte le MÊME identifiant que la
 *   demande ; ce qui s'inverse est le TYPE (8 → 0). Traiter ICMP comme TCP
 *   produirait une clé de retour que la réponse ne porte jamais, donc un
 *   `ping` qui ne se referme pas — et l'inspection à états s'effondre sur
 *   le protocole le plus utilisé en diagnostic.
 * — Les protocoles sans port (GRE, ESP) n'ont ni l'un ni l'autre.
 *
 * `reverse(reverse(k)) === k` est vérifié sur les trois familles parce que
 * c'est l'invariant qui garantit qu'aucun sens ne se perd.
 */

import { describe, it, expect } from 'vitest';
import {
  flowKeyFromPacket,
  flowKeyToString,
  reverseFlowKey,
  flowKeyEquals,
  type FlowKey,
} from '@/network/devices/firewall/session/FlowKey';
import {
  IPAddress,
  IP_PROTO_ICMP,
  IP_PROTO_TCP,
  IP_PROTO_UDP,
  type IPv4Packet,
  type TCPPacket,
  type UDPPacket,
  type ICMPPacket,
  type ICMPType,
} from '@/network/core/types';

const IP_PROTO_GRE = 47;

function ipv4(src: string, dst: string, protocol: number, payload: unknown): IPv4Packet {
  return {
    type: 'ipv4',
    version: 4,
    ihl: 5,
    tos: 0,
    totalLength: 40,
    identification: 1,
    flags: 0,
    fragmentOffset: 0,
    ttl: 64,
    protocol,
    headerChecksum: 0,
    sourceIP: new IPAddress(src),
    destinationIP: new IPAddress(dst),
    payload,
  } as IPv4Packet;
}

function tcp(sourcePort: number, destinationPort: number): TCPPacket {
  return {
    type: 'tcp',
    sourcePort,
    destinationPort,
    sequenceNumber: 0,
    acknowledgementNumber: 0,
    flags: { syn: true, ack: false, fin: false, rst: false, psh: false, urg: false },
    windowSize: 65535,
    checksum: 0,
    payload: null,
  } as TCPPacket;
}

function udp(sourcePort: number, destinationPort: number): UDPPacket {
  return {
    type: 'udp',
    sourcePort,
    destinationPort,
    length: 8,
    checksum: 0,
    payload: null,
  } as UDPPacket;
}

function icmp(icmpType: ICMPType, id: number): ICMPPacket {
  return {
    type: 'icmp',
    icmpType,
    code: 0,
    id,
    sequence: 1,
    dataSize: 56,
  } as ICMPPacket;
}

describe('FlowKey — construction depuis un paquet', () => {
  it('lit les ports réels d\'un segment TCP', () => {
    const key = flowKeyFromPacket(ipv4('192.168.1.10', '203.0.113.5', IP_PROTO_TCP, tcp(54321, 80)));

    expect(key.sourceIP).toBe('192.168.1.10');
    expect(key.sourcePort).toBe(54321);
    expect(key.destIP).toBe('203.0.113.5');
    expect(key.destPort).toBe(80);
    expect(key.protocol).toBe(IP_PROTO_TCP);
  });

  it('lit les ports réels d\'un datagramme UDP', () => {
    const key = flowKeyFromPacket(ipv4('192.168.1.10', '8.8.8.8', IP_PROTO_UDP, udp(40000, 53)));

    expect(key.sourcePort).toBe(40000);
    expect(key.destPort).toBe(53);
    expect(key.protocol).toBe(IP_PROTO_UDP);
  });

  it('range l\'identifiant ICMP dans l\'emplacement de port source', () => {
    const key = flowKeyFromPacket(ipv4('192.168.1.10', '8.8.8.8', IP_PROTO_ICMP, icmp('echo-request', 4242)));

    expect(key.sourcePort).toBe(4242);
  });

  it('range le type ICMP NUMÉRIQUE dans l\'emplacement de port destination', () => {
    const request = flowKeyFromPacket(ipv4('10.0.0.1', '10.0.0.2', IP_PROTO_ICMP, icmp('echo-request', 1)));
    const reply = flowKeyFromPacket(ipv4('10.0.0.2', '10.0.0.1', IP_PROTO_ICMP, icmp('echo-reply', 1)));

    expect(request.destPort).toBe(8);
    expect(reply.destPort).toBe(0);
  });

  it('met les deux ports à zéro pour un protocole qui n\'en a pas', () => {
    const key = flowKeyFromPacket(ipv4('10.0.0.1', '10.0.0.2', IP_PROTO_GRE, null));

    expect(key.sourcePort).toBe(0);
    expect(key.destPort).toBe(0);
    expect(key.protocol).toBe(IP_PROTO_GRE);
  });

  it('met les ports à zéro si la charge utile ne correspond pas au protocole annoncé', () => {
    const key = flowKeyFromPacket(ipv4('10.0.0.1', '10.0.0.2', IP_PROTO_TCP, null));

    expect(key.sourcePort).toBe(0);
    expect(key.destPort).toBe(0);
  });

  it('rend un objet gelé — un objet-valeur ne se mute pas', () => {
    const key = flowKeyFromPacket(ipv4('10.0.0.1', '10.0.0.2', IP_PROTO_TCP, tcp(1, 2)));

    expect(Object.isFrozen(key)).toBe(true);
  });
});

describe('FlowKey — clé canonique', () => {
  it('rend la même chaîne pour deux clés portant le même quintuplet', () => {
    const a = flowKeyFromPacket(ipv4('192.168.1.10', '203.0.113.5', IP_PROTO_TCP, tcp(54321, 80)));
    const b = flowKeyFromPacket(ipv4('192.168.1.10', '203.0.113.5', IP_PROTO_TCP, tcp(54321, 80)));

    expect(flowKeyToString(a)).toBe(flowKeyToString(b));
  });

  it('distingue deux flux qui ne diffèrent que par le protocole', () => {
    const viaTcp = flowKeyFromPacket(ipv4('10.0.0.1', '10.0.0.2', IP_PROTO_TCP, tcp(1000, 53)));
    const viaUdp = flowKeyFromPacket(ipv4('10.0.0.1', '10.0.0.2', IP_PROTO_UDP, udp(1000, 53)));

    expect(flowKeyToString(viaTcp)).not.toBe(flowKeyToString(viaUdp));
  });

  it('distingue deux flux qui ne diffèrent que par le port source', () => {
    const a = flowKeyFromPacket(ipv4('10.0.0.1', '10.0.0.2', IP_PROTO_TCP, tcp(1000, 80)));
    const b = flowKeyFromPacket(ipv4('10.0.0.1', '10.0.0.2', IP_PROTO_TCP, tcp(1001, 80)));

    expect(flowKeyToString(a)).not.toBe(flowKeyToString(b));
  });

  it('distingue le sens aller du sens retour', () => {
    const key = flowKeyFromPacket(ipv4('10.0.0.1', '10.0.0.2', IP_PROTO_TCP, tcp(1000, 80)));

    expect(flowKeyToString(key)).not.toBe(flowKeyToString(reverseFlowKey(key)));
  });
});

describe('FlowKey — inversion, TCP et UDP', () => {
  it('échange les couples adresse/port pour TCP', () => {
    const key = flowKeyFromPacket(ipv4('192.168.1.10', '203.0.113.5', IP_PROTO_TCP, tcp(54321, 80)));
    const back = reverseFlowKey(key);

    expect(back.sourceIP).toBe('203.0.113.5');
    expect(back.sourcePort).toBe(80);
    expect(back.destIP).toBe('192.168.1.10');
    expect(back.destPort).toBe(54321);
    expect(back.protocol).toBe(IP_PROTO_TCP);
  });

  it('reconnaît le segment de retour réel comme la clé inverse', () => {
    const outbound = flowKeyFromPacket(ipv4('192.168.1.10', '203.0.113.5', IP_PROTO_TCP, tcp(54321, 80)));
    const inbound = flowKeyFromPacket(ipv4('203.0.113.5', '192.168.1.10', IP_PROTO_TCP, tcp(80, 54321)));

    expect(flowKeyToString(reverseFlowKey(outbound))).toBe(flowKeyToString(inbound));
  });

  it('reconnaît le datagramme de retour réel comme la clé inverse', () => {
    const query = flowKeyFromPacket(ipv4('192.168.1.10', '8.8.8.8', IP_PROTO_UDP, udp(40000, 53)));
    const answer = flowKeyFromPacket(ipv4('8.8.8.8', '192.168.1.10', IP_PROTO_UDP, udp(53, 40000)));

    expect(flowKeyToString(reverseFlowKey(query))).toBe(flowKeyToString(answer));
  });
});

describe('FlowKey — inversion, ICMP', () => {
  it('GARDE l\'identifiant et inverse le TYPE — une réponse d\'écho porte le même id', () => {
    const request = flowKeyFromPacket(ipv4('192.168.1.10', '8.8.8.8', IP_PROTO_ICMP, icmp('echo-request', 4242)));
    const back = reverseFlowKey(request);

    expect(back.sourcePort).toBe(4242);
    expect(back.destPort).toBe(0);
  });

  it('reconnaît la réponse d\'écho RÉELLE comme la clé inverse', () => {
    const request = flowKeyFromPacket(ipv4('192.168.1.10', '8.8.8.8', IP_PROTO_ICMP, icmp('echo-request', 4242)));
    const reply = flowKeyFromPacket(ipv4('8.8.8.8', '192.168.1.10', IP_PROTO_ICMP, icmp('echo-reply', 4242)));

    expect(flowKeyToString(reverseFlowKey(request))).toBe(flowKeyToString(reply));
  });

  it('n\'échange PAS les ports comme le ferait TCP — le témoin qui attrape la confusion', () => {
    const request = flowKeyFromPacket(ipv4('192.168.1.10', '8.8.8.8', IP_PROTO_ICMP, icmp('echo-request', 4242)));
    const back = reverseFlowKey(request);

    expect(back.sourcePort).not.toBe(8);
    expect(back.destPort).not.toBe(4242);
  });

  it('laisse un type ICMP sans réciproque tel quel', () => {
    const unreachable = flowKeyFromPacket(
      ipv4('10.0.0.254', '192.168.1.10', IP_PROTO_ICMP, icmp('destination-unreachable', 0)));
    const back = reverseFlowKey(unreachable);

    expect(back.destPort).toBe(3);
  });
});

describe('FlowKey — invariants', () => {
  const cases: Array<[string, FlowKey]> = [
    ['TCP', flowKeyFromPacket(ipv4('192.168.1.10', '203.0.113.5', IP_PROTO_TCP, tcp(54321, 80)))],
    ['UDP', flowKeyFromPacket(ipv4('192.168.1.10', '8.8.8.8', IP_PROTO_UDP, udp(40000, 53)))],
    ['ICMP écho', flowKeyFromPacket(ipv4('192.168.1.10', '8.8.8.8', IP_PROTO_ICMP, icmp('echo-request', 7)))],
    ['ICMP erreur', flowKeyFromPacket(ipv4('10.0.0.1', '10.0.0.2', IP_PROTO_ICMP, icmp('destination-unreachable', 0)))],
    ['GRE', flowKeyFromPacket(ipv4('10.0.0.1', '10.0.0.2', IP_PROTO_GRE, null))],
  ];

  it.each(cases)('inverser deux fois redonne la clé de départ — %s', (_label, key) => {
    expect(flowKeyEquals(reverseFlowKey(reverseFlowKey(key)), key)).toBe(true);
  });

  it.each(cases)('la clé inversée est gelée elle aussi — %s', (_label, key) => {
    expect(Object.isFrozen(reverseFlowKey(key))).toBe(true);
  });

  it('flowKeyEquals est vrai pour deux clés distinctes portant le même quintuplet', () => {
    const a = flowKeyFromPacket(ipv4('10.0.0.1', '10.0.0.2', IP_PROTO_TCP, tcp(1, 2)));
    const b = flowKeyFromPacket(ipv4('10.0.0.1', '10.0.0.2', IP_PROTO_TCP, tcp(1, 2)));

    expect(a).not.toBe(b);
    expect(flowKeyEquals(a, b)).toBe(true);
  });

  it('flowKeyEquals est faux dès qu\'un champ diffère', () => {
    const a = flowKeyFromPacket(ipv4('10.0.0.1', '10.0.0.2', IP_PROTO_TCP, tcp(1, 2)));
    const b = flowKeyFromPacket(ipv4('10.0.0.1', '10.0.0.2', IP_PROTO_TCP, tcp(1, 3)));

    expect(flowKeyEquals(a, b)).toBe(false);
  });
});
