import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { Cable } from '@/network/hardware/Cable';
import { MACAddress, resetCounters } from '@/network/core/types';
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

interface Hote {
  executeCommand(command: string): Promise<string>;
  getPort(name: string): unknown;
  getTcpStack(): TcpLike;
  powerOn(): void;
}

interface SocketLike {
  state: string;
  localPort: number;
  remoteIp: string;
  remotePort: number;
  send(data: unknown): void;
  close(): void;
  onData(handler: (data: unknown) => void): () => void;
}

interface TcpLike {
  connect(ip: string, port: number, opts?: Record<string, unknown>): SocketLike | null;
  listen(port: number, opts: { onAccept: (socket: SocketLike) => void }): unknown;
}

async function paire(): Promise<{ client: Hote; serveur: Hote }> {
  const client = new LinuxPC('linux-pc', 'CLIENT', 0, 0) as unknown as Hote;
  const serveur = new LinuxServer('linux-server', 'SERVEUR', 200, 0) as unknown as Hote;
  client.powerOn();
  serveur.powerOn();
  new Cable('lien').connect(client.getPort('eth0') as never, serveur.getPort('eth0') as never);

  for (const c of ['ip link set eth0 up', 'ip addr add 10.0.0.1/24 dev eth0']) {
    await client.executeCommand(c);
  }
  for (const c of ['ip link set eth0 up', 'ip addr add 10.0.0.2/24 dev eth0']) {
    await serveur.executeCommand(c);
  }
  return { client, serveur };
}

describe('la poignee de main en trois temps — RFC 9293 §3.5', () => {
  it('un connect vers un port qui ECOUTE atteint `established`', async () => {
    const { client, serveur } = await paire();
    serveur.getTcpStack().listen(9000, { onAccept: () => { /* accepte */ } });

    const socket = client.getTcpStack().connect('10.0.0.2', 9000);

    expect(socket).not.toBeNull();
    expect(socket!.state).toBe('established');
  });

  it('le serveur voit la connexion ARRIVER, avec l adresse du client', async () => {
    const { client, serveur } = await paire();
    let vu: SocketLike | null = null;
    serveur.getTcpStack().listen(9000, { onAccept: (s) => { vu = s; } });

    client.getTcpStack().connect('10.0.0.2', 9000);

    expect(vu).not.toBeNull();
    expect((vu as unknown as SocketLike).remoteIp).toBe('10.0.0.1');
  });

  it('un connect vers un port FERME n aboutit pas', async () => {
    const { client } = await paire();

    const socket = client.getTcpStack().connect('10.0.0.2', 9999);

    expect(socket === null || socket.state !== 'established').toBe(true);
  });

  it('deux connexions depuis le meme hote prennent deux ports source', async () => {
    const { client, serveur } = await paire();
    serveur.getTcpStack().listen(9000, { onAccept: () => { /* accepte */ } });

    const un = client.getTcpStack().connect('10.0.0.2', 9000);
    const deux = client.getTcpStack().connect('10.0.0.2', 9000);

    expect(un!.localPort).not.toBe(deux!.localPort);
  });
});

describe('les donnees traversent, dans les deux sens', () => {
  it('ce que le client envoie, le serveur le recoit', async () => {
    const { client, serveur } = await paire();
    const recu: string[] = [];
    serveur.getTcpStack().listen(9000, {
      onAccept: (s) => { s.onData((d) => { recu.push(String(d)); }); },
    });

    const socket = client.getTcpStack().connect('10.0.0.2', 9000);
    socket!.send('bonjour');

    expect(recu.join('')).toContain('bonjour');
  });

  it('et la reponse revient au client', async () => {
    const { client, serveur } = await paire();
    serveur.getTcpStack().listen(9000, {
      onAccept: (s) => { s.onData(() => { s.send('pong'); }); },
    });

    const recu: string[] = [];
    const socket = client.getTcpStack().connect('10.0.0.2', 9000);
    socket!.onData((d) => { recu.push(String(d)); });
    socket!.send('ping');

    expect(recu.join('')).toContain('pong');
  });

  it('plusieurs envois arrivent dans l ORDRE', async () => {
    const { client, serveur } = await paire();
    const recu: string[] = [];
    serveur.getTcpStack().listen(9000, {
      onAccept: (s) => { s.onData((d) => { recu.push(String(d)); }); },
    });

    const socket = client.getTcpStack().connect('10.0.0.2', 9000);
    for (const mot of ['un', 'deux', 'trois']) socket!.send(mot);

    expect(recu.join('')).toBe('undeuxtrois');
  });
});

describe('la fermeture — RFC 9293 §3.6', () => {
  it('`close` fait quitter `established`', async () => {
    const { client, serveur } = await paire();
    serveur.getTcpStack().listen(9000, { onAccept: () => { /* accepte */ } });

    const socket = client.getTcpStack().connect('10.0.0.2', 9000);
    socket!.close();

    expect(socket!.state).not.toBe('established');
  });

  it('le PAIR apprend la fermeture', async () => {
    const { client, serveur } = await paire();
    let cote: SocketLike | null = null;
    serveur.getTcpStack().listen(9000, { onAccept: (s) => { cote = s; } });

    const socket = client.getTcpStack().connect('10.0.0.2', 9000);
    socket!.close();

    expect((cote as unknown as SocketLike).state).not.toBe('established');
  });
});

describe('la couche IP porte ce que TCP lui confie', () => {
  it('un segment part avec l adresse de l interface de sortie', async () => {
    const { client, serveur } = await paire();
    let vu: SocketLike | null = null;
    serveur.getTcpStack().listen(9000, { onAccept: (s) => { vu = s; } });

    client.getTcpStack().connect('10.0.0.2', 9000);

    expect((vu as unknown as SocketLike).remoteIp).toBe('10.0.0.1');
  });

  it('`ss -tn` montre la connexion ETABLIE des deux cotes', async () => {
    const { client, serveur } = await paire();
    serveur.getTcpStack().listen(9000, { onAccept: () => { /* accepte */ } });
    client.getTcpStack().connect('10.0.0.2', 9000);

    expect(await client.executeCommand('ss -tn')).toMatch(/10\.0\.0\.2:9000/);
    expect(await serveur.executeCommand('ss -tn')).toMatch(/10\.0\.0\.1/);
  });

  it('`ss -ltn` montre le port en ECOUTE', async () => {
    const { serveur } = await paire();
    serveur.getTcpStack().listen(9000, { onAccept: () => { /* accepte */ } });

    expect(await serveur.executeCommand('ss -ltn')).toMatch(/9000/);
  });
});

describe('un port INJOIGNABLE se distingue d un port ferme', () => {
  it('vers une adresse sans hote, la connexion n aboutit pas', async () => {
    const { client } = await paire();

    const socket = client.getTcpStack().connect('10.0.0.99', 9000);

    expect(socket === null || socket.state !== 'established').toBe(true);
  });

  it('et le ping vers cette adresse echoue aussi', async () => {
    const { client } = await paire();

    expect(await client.executeCommand('ping -c 1 -W 1 10.0.0.99'))
      .toMatch(/100% packet loss|Unreachable/);
  });
});
