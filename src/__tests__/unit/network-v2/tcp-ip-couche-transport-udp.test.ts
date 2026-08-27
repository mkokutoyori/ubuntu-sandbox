import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { Cable } from '@/network/hardware/Cable';
import { IPAddress, MACAddress, resetCounters } from '@/network/core/types';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  MACAddress.resetCounter();
  Logger.reset();
  EquipmentRegistry.resetInstance();
});

interface Datagram {
  sourceIP: { toString(): string };
  udp: { sourcePort: number; destinationPort: number; payload: unknown; checksum: number };
}

interface Host {
  executeCommand(command: string): Promise<string>;
  getPort(name: string): unknown;
  powerOn(): void;
  udpBind(port: number, handler: (d: Datagram) => void): boolean;
  udpClose(port: number): void;
  sendUdpDatagram(dstIp: IPAddress, dstPort: number, srcPort: number, payload: unknown): boolean;
}

async function pair(): Promise<{ client: Host; server: Host }> {
  const client = new LinuxPC('linux-pc', 'CLIENT', 0, 0) as unknown as Host;
  const server = new LinuxServer('linux-server', 'SERVEUR', 200, 0) as unknown as Host;
  client.powerOn();
  server.powerOn();
  new Cable('lien').connect(client.getPort('eth0') as never, server.getPort('eth0') as never);
  for (const c of ['ip link set eth0 up', 'ip addr add 10.0.0.1/24 dev eth0']) {
    await client.executeCommand(c);
  }
  for (const c of ['ip link set eth0 up', 'ip addr add 10.0.0.2/24 dev eth0']) {
    await server.executeCommand(c);
  }
  return { client, server };
}

describe('un datagramme traverse — RFC 768', () => {
  it('ce que le client envoie, le serveur le recoit', async () => {
    const { client, server } = await pair();
    const recus: Datagram[] = [];
    server.udpBind(5000, (d) => { recus.push(d); });

    expect(client.sendUdpDatagram(new IPAddress('10.0.0.2'), 5000, 4000, 'bonjour')).toBe(true);
    expect(recus).toHaveLength(1);
    expect(recus[0].udp.payload).toBe('bonjour');
  });

  it('le datagramme porte l adresse ET le port de sa source', async () => {
    const { client, server } = await pair();
    const recus: Datagram[] = [];
    server.udpBind(5000, (d) => { recus.push(d); });
    client.sendUdpDatagram(new IPAddress('10.0.0.2'), 5000, 4321, 'x');

    expect(recus[0].sourceIP.toString()).toBe('10.0.0.1');
    expect(recus[0].udp.sourcePort).toBe(4321);
  });

  it('un port que PERSONNE n ecoute ne livre rien', async () => {
    const { client, server } = await pair();
    const recus: Datagram[] = [];
    server.udpBind(5000, (d) => { recus.push(d); });

    client.sendUdpDatagram(new IPAddress('10.0.0.2'), 5001, 4000, 'x');

    expect(recus).toHaveLength(0);
  });

  it('et la reponse revient au port source', async () => {
    const { client, server } = await pair();
    const chezClient: Datagram[] = [];
    client.udpBind(4000, (d) => { chezClient.push(d); });
    server.udpBind(5000, (d) => {
      server.sendUdpDatagram(new IPAddress(d.sourceIP.toString()), d.udp.sourcePort, 5000, 'pong');
    });

    client.sendUdpDatagram(new IPAddress('10.0.0.2'), 5000, 4000, 'ping');

    expect(chezClient.map(d => d.udp.payload)).toEqual(['pong']);
  });
});

describe('une seule table de ports', () => {
  it('deux liaisons sur le MEME port UDP ne peuvent pas coexister', async () => {
    const { server } = await pair();
    server.udpBind(5000, () => { /* premier */ });

    expect(server.udpBind(5000, () => { /* second */ })).toBe(false);
  });

  it('et la PREMIERE liaison survit au refus', async () => {
    const { client, server } = await pair();
    const recus: Datagram[] = [];
    server.udpBind(5000, (d) => { recus.push(d); });
    server.udpBind(5000, () => { /* refuse */ });

    client.sendUdpDatagram(new IPAddress('10.0.0.2'), 5000, 4000, 'toujours la');

    expect(recus.map(d => d.udp.payload)).toEqual(['toujours la']);
  });

  it('un port libere se relie', async () => {
    const { server } = await pair();
    server.udpBind(5000, () => { /* premier */ });
    server.udpClose(5000);

    expect(server.udpBind(5000, () => { /* second */ })).toBe(true);
  });

  it('`ss -lun` montre le port UDP en ecoute', async () => {
    const { server } = await pair();
    server.udpBind(5000, () => { /* ecoute */ });

    expect(await server.executeCommand('ss -lun')).toMatch(/5000/);
  });

  it('UDP et TCP nomment deux espaces de ports distincts', async () => {
    const { server } = await pair();
    server.udpBind(5000, () => { /* udp */ });
    const tcp = (server as unknown as {
      getTcpStack(): { listen(p: number, o: { onAccept: () => void }): unknown };
    }).getTcpStack();

    expect(() => tcp.listen(5000, { onAccept: () => { /* tcp */ } })).not.toThrow();
  });

  it('et `ss -lun` ne montre pas le port TCP', async () => {
    const { server } = await pair();
    (server as unknown as {
      getTcpStack(): { listen(p: number, o: { onAccept: () => void }): unknown };
    }).getTcpStack().listen(6001, { onAccept: () => { /* tcp */ } });

    expect(await server.executeCommand('ss -lun')).not.toMatch(/6001/);
  });
});

describe('la somme de controle est VERIFIEE — RFC 768', () => {
  it('un datagramme intact est livre', async () => {
    const { client, server } = await pair();
    const recus: Datagram[] = [];
    server.udpBind(5000, (d) => { recus.push(d); });

    client.sendUdpDatagram(new IPAddress('10.0.0.2'), 5000, 4000, 'intact');

    expect(recus).toHaveLength(1);
  });

  it('une somme FAUSSE fait tomber le datagramme', async () => {
    const { client, server } = await pair();
    const recus: Datagram[] = [];
    server.udpBind(5000, (d) => { recus.push(d); });

    const port = client.getPort('eth0') as {
      sendFrame(f: unknown): void;
    };
    const original = port.sendFrame.bind(port);
    port.sendFrame = (frame: unknown) => {
      const udp = (frame as { payload?: { payload?: { checksum?: number } } })
        .payload?.payload;
      if (udp && typeof udp.checksum === 'number' && udp.checksum !== 0) {
        udp.checksum = (udp.checksum ^ 0xffff) & 0xffff;
      }
      original(frame);
    };
    client.sendUdpDatagram(new IPAddress('10.0.0.2'), 5000, 4000, 'corrompu');

    expect(recus).toHaveLength(0);
  });
});
