/*
 * Un serveur DHCP repond a un DHCPINFORM par un DHCPACK sans bail, et offre
 * l'adresse que le client demande (option 50) quand elle est libre.
 *
 * L'AUTORITE : RFC 2131.
 * - §3.4 et §4.3.5 : le serveur repond a un DHCPINFORM par un DHCPACK envoye
 *   directement a l'adresse de `ciaddr` ; il NE DOIT PAS y mettre de duree
 *   de bail et NE DEVRAIT PAS renseigner `yiaddr` ; il donne les autres
 *   parametres (masque, routeur, DNS, domaine) ;
 * - §4.3.1 : pour un DHCPDISCOVER, le serveur choisit l'adresse dans cet
 *   ordre — le bail en cours du client, l'ancienne adresse du client si elle
 *   est libre, l'adresse de l'option 50 « Requested IP Address » si elle est
 *   valide et libre, sinon une adresse neuve du reservoir.
 *
 * Ecrite a l'aveugle, avant de lire `DhcpServerExchange` et `processDiscover`.
 * Le moteur est celui que Router, Linux, Windows et FortiGate partagent ;
 * un dernier cas fait passer un DHCPINFORM sur le cable d'un FortiGate.
 * 4 des 11 cas tombent avant. Passent des deux cotes les TEMOINS : la
 * premiere adresse libre sans demande, l'absence d'adresse prise dans le
 * reservoir par un INFORM, un client hors de tout reservoir, et les trois
 * demandes refusees (adresse tenue par un autre, exclue, hors reservoir) —
 * ces trois-la passaient parce que l'option 50 etait ignoree, et doivent
 * survivre a l'avoir lue — ainsi que le bail en cours du client.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { DHCPServer } from '@/network/dhcp/DHCPServer';
import { DHCPPacket, DHCP_OPTION, DHCP_WIRE_BYTES } from '@/network/dhcp/DHCPPacket';
import { buildDhcpServerReply, dhcpReplyRoute } from '@/network/dhcp/DhcpServerExchange';
import { FortiGate } from '@/network/devices/firewall/vendors/fortios/FortiGate';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { Cable } from '@/network/hardware/Cable';
import { resetCounters, MACAddress, IPAddress, ETHERTYPE_IPV4, type IPv4Packet, type UDPPacket } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  MACAddress.resetCounter();
  Logger.reset();
});

function server(): DHCPServer {
  const engine = new DHCPServer();
  engine.setServerIdentifier('192.168.10.1');
  engine.createPool('lan');
  engine.configurePoolNetwork('lan', '192.168.10.0', '255.255.255.0');
  engine.configurePoolRouter('lan', '192.168.10.1');
  engine.configurePoolDNS('lan', ['8.8.8.8']);
  engine.configurePoolDomain('lan', 'lab.local');
  engine.configurePoolLease('lan', 3600);
  engine.addExcludedRange('192.168.10.1', '192.168.10.99');
  engine.enable();
  return engine;
}

function discover(mac: string, requested?: string): DHCPPacket {
  const packet = DHCPPacket.createDiscover(mac, 1);
  if (requested !== undefined) packet.setOption(DHCP_OPTION.REQUESTED_IP, requested);
  return packet;
}

const MAC_A = '02:00:00:00:00:0A';
const MAC_B = '02:00:00:00:00:0B';

describe('DHCPINFORM', () => {
  it('is answered by a DHCPACK with the parameters and no lease', () => {
    const engine = server();
    const inform = DHCPPacket.createInform(MAC_A, 9, '192.168.10.50');
    const reply = buildDhcpServerReply(inform, { server: engine, localGatewayIP: '192.168.10.1' });

    expect(reply?.getMessageType()).toBe('DHCPACK');
    expect(reply?.yiaddr).toBe('0.0.0.0');
    expect(reply?.getOption(DHCP_OPTION.LEASE_TIME)).toBeUndefined();
    expect(reply?.getOption(DHCP_OPTION.SUBNET_MASK)).toBe('255.255.255.0');
    expect(reply?.getOption(DHCP_OPTION.ROUTER)).toBe('192.168.10.1');
    expect(reply?.getOption(DHCP_OPTION.DNS)).toEqual(['8.8.8.8']);
    expect(reply?.getOption(DHCP_OPTION.DOMAIN_NAME)).toBe('lab.local');
  });

  it('is answered to the address the client already holds', () => {
    const engine = server();
    const inform = DHCPPacket.createInform(MAC_A, 9, '192.168.10.50');
    const reply = buildDhcpServerReply(inform, { server: engine, localGatewayIP: '192.168.10.1' })!;

    expect(dhcpReplyRoute(inform, reply)).toEqual({ kind: 'unicast', address: '192.168.10.50' });
    expect(reply.xid).toBe(9);
  });

  it('takes no address from the pool', () => {
    const engine = server();
    buildDhcpServerReply(DHCPPacket.createInform(MAC_A, 9, '192.168.10.50'), { server: engine, localGatewayIP: '192.168.10.1' });

    expect([...engine.getBindings().keys()]).toEqual([]);
  });

  it('a client outside every pool gets no answer', () => {
    const engine = server();
    const reply = buildDhcpServerReply(DHCPPacket.createInform(MAC_A, 9, '172.16.0.5'), { server: engine });

    expect(reply).toBeNull();
  });

  it('crosses a FortiGate on the wire and comes back as a DHCPACK', async () => {
    const fgt = new FortiGate('firewall-fortinet', 'FGT-01', 0, 0);
    const pc = new LinuxPC('linux-pc', 'PC1', -200, 0);
    new Cable('lan').connect(pc.getPort('eth0')!, fgt.getPort('port2')!);
    for (const line of ['ip addr add 192.168.10.50/24 dev eth0', 'ip link set eth0 up']) await pc.executeCommand(line);
    for (const line of [
      'config system interface', 'edit port2', 'set mode static', 'set ip 192.168.10.1 255.255.255.0', 'next', 'end',
      'config system dhcp server', 'edit 1', 'set interface "port2"', 'set default-gateway 192.168.10.1',
      'set netmask 255.255.255.0', 'config ip-range', 'edit 1', 'set start-ip 192.168.10.100',
      'set end-ip 192.168.10.110', 'next', 'end', 'next', 'end',
    ]) await fgt.executeCommand(line);
    const acks: DHCPPacket[] = [];
    pc.getPort('eth0')!.attachTap(({ direction, frame }) => {
      if (direction !== 'in' || frame.etherType !== ETHERTYPE_IPV4) return;
      const udp = (frame.payload as IPv4Packet).payload as UDPPacket | undefined;
      if (udp?.type === 'udp' && udp.payload instanceof DHCPPacket && udp.payload.getMessageType() === 'DHCPACK') acks.push(udp.payload);
    });

    pc.sendUdpDatagram({
      destination: new IPAddress('192.168.10.1'), destinationPort: 67, sourcePort: 68,
      payload: DHCPPacket.createInform(pc.getPort('eth0')!.getMAC().toString(), 21, '192.168.10.50'),
      payloadBytes: DHCP_WIRE_BYTES,
    });

    expect(acks.length).toBe(1);
    expect(acks[0].getOption(DHCP_OPTION.SUBNET_MASK)).toBe('255.255.255.0');
    expect(acks[0].yiaddr).toBe('0.0.0.0');
  });
});

describe('the address a client asks for in a DISCOVER', () => {
  it('without a request the first free address is offered — WITNESS', () => {
    const offer = buildDhcpServerReply(discover(MAC_A), { server: server(), localGatewayIP: '192.168.10.1' });

    expect(offer?.yiaddr).toBe('192.168.10.100');
  });

  it('is offered when it is free', () => {
    const offer = buildDhcpServerReply(discover(MAC_A, '192.168.10.150'), { server: server(), localGatewayIP: '192.168.10.1' });

    expect(offer?.yiaddr).toBe('192.168.10.150');
  });

  it('is not offered when another client holds it', () => {
    const engine = server();
    engine.processRequestWithNak({ clientMAC: MAC_B, xid: 2, requestedIP: '192.168.10.150', clientIdentifier: MAC_B });
    const offer = buildDhcpServerReply(discover(MAC_A, '192.168.10.150'), { server: engine, localGatewayIP: '192.168.10.1' });

    expect(offer?.yiaddr).toBe('192.168.10.100');
  });

  it('is not offered when it lies in an excluded range', () => {
    const offer = buildDhcpServerReply(discover(MAC_A, '192.168.10.20'), { server: server(), localGatewayIP: '192.168.10.1' });

    expect(offer?.yiaddr).toBe('192.168.10.100');
  });

  it('is not offered when it lies outside the pool', () => {
    const offer = buildDhcpServerReply(discover(MAC_A, '10.9.9.9'), { server: server(), localGatewayIP: '192.168.10.1' });

    expect(offer?.yiaddr).toBe('192.168.10.100');
  });

  it('never beats the current binding of the client (RFC 2131 §4.3.1, first choice)', () => {
    const engine = server();
    engine.processRequestWithNak({ clientMAC: MAC_A, xid: 2, requestedIP: '192.168.10.120', clientIdentifier: MAC_A });
    const offer = buildDhcpServerReply(discover(MAC_A, '192.168.10.150'), { server: engine, localGatewayIP: '192.168.10.1' });

    expect(offer?.yiaddr).toBe('192.168.10.120');
  });
});
