/**
 * `ssh -L` / `-R` / `-D` d'une session INTERACTIVE doivent relayer de
 * vrais octets.
 *
 * GAP.md §7.3 : ce chemin ouvrait un canal d'exécution `nc <hôte> <port>`
 * dont `execute()` n'est jamais appelé — le `nc` distant n'était donc même
 * pas lancé, et rien n'était ponté. La Phase 8 n'a réparé que l'AUTRE pile
 * (`executeCommand`/`SshForwardingTable`) ; les deux ne s'interopèrent pas.
 *
 * La mesure ne peut pas être « le port écoute » : il écoutait déjà, et
 * c'est précisément ce qui rendait le trou invisible. Elle est qu'un octet
 * écrit d'un côté ressorte de l'autre.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { GenericSwitch } from '@/network/devices/GenericSwitch';
import { Cable } from '@/network/hardware/Cable';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import { IPAddress, SubnetMask, MACAddress, resetCounters } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { LinuxTerminalSession } from '@/terminal/sessions/LinuxTerminalSession';
import { installDefaultShells } from '@/shell/registerDefaults';

const CLI = '10.95.0.10';
const SRV = '10.95.0.20';
const MASK = new SubnetMask('255.255.255.0');

const key = (k: string) =>
  ({ key: k, ctrlKey: false, shiftKey: false, altKey: false, metaKey: false }) as never;
const tick = (ms = 20) => new Promise<void>((r) => setTimeout(r, ms));

interface Sock {
  state: string;
  send(data: string): void;
  onData(handler: (data: string) => void): () => void;
  close(): void;
}

beforeEach(() => {
  installDefaultShells();
  EquipmentRegistry.getInstance().clear();
  resetCounters();
  resetDeviceCounters();
  MACAddress.resetCounter();
  Logger.reset();
});

function lab() {
  const client = new LinuxPC('linux-pc', 'CLI');
  const server = new LinuxServer('linux-server', 'SRV');
  const sw = new GenericSwitch('switch-generic', 'SW');
  new Cable('c1').connect(client.getPorts()[0], sw.getPorts()[0]);
  new Cable('c2').connect(server.getPorts()[0], sw.getPorts()[1]);
  client.getPorts()[0].configureIP(new IPAddress(CLI), MASK);
  server.getPorts()[0].configureIP(new IPAddress(SRV), MASK);
  client.powerOn();
  server.powerOn();
  return { client, server };
}

/** Un service d'écho : ce qu'il reçoit prouve que l'octet est arrivé. */
function echoService(
  device: { getTcpStack(): { listen(port: number, h: unknown): void } },
  port: number,
): string[] {
  const received: string[] = [];
  device.getTcpStack().listen(port, {
    onAccept: (s: { onData(h: (d: string) => void): void; send(d: string): void }) => {
      s.onData((d) => {
        received.push(d);
        s.send(`ECHO:${d}`);
      });
    },
  });
  return received;
}

/** Ouvre la vraie session interactive, options de forward comprises. */
async function sshWith(
  client: LinuxPC,
  args: string,
): Promise<LinuxTerminalSession> {
  const term = new LinuxTerminalSession('t1', client);
  await term.init?.();
  term.setInput(`ssh ${args} alice@${SRV}`);
  term.handleKey(key('Enter'));
  for (let i = 0; i < 40 && term.currentInputMode.type !== 'password'; i++) await tick(25);
  term.setPasswordBuf('alice');
  term.handleKey(key('Enter'));
  for (let i = 0; i < 40 && !/alice@/.test(term.foreground.getPrompt()); i++) await tick(25);
  expect(
    term.foreground.getPrompt(),
    'la session doit être ouverte, sinon la mesure ne dit rien',
  ).toMatch(/alice@/);
  return term;
}

async function connected(
  device: { getTcpStack(): { connect(h: string, p: number): unknown } },
  host: string,
  port: number,
): Promise<Sock> {
  const sock = device.getTcpStack().connect(host, port) as Sock | null;
  expect(sock).not.toBeNull();
  for (let i = 0; i < 60 && sock!.state === 'syn-sent'; i++) await tick();
  return sock!;
}

describe('les forwards d’une session ssh interactive relaient de vrais octets', () => {
  it('-L : ce que le client écrit sur le port local ressort chez le service distant', async () => {
    const { client, server } = lab();
    const recu = echoService(server, 8080);
    await sshWith(client, `-L 15000:${SRV}:8080`);

    const sock = await connected(client, '127.0.0.1', 15000);
    expect(sock.state).toBe('established');
    const repondu: string[] = [];
    sock.onData((d) => repondu.push(d));
    sock.send('PING');
    for (let i = 0; i < 60 && repondu.length === 0; i++) await tick();

    expect(recu.join(''), 'le service distant a vu l’octet').toContain('PING');
    expect(repondu.join(''), 'et sa réponse est revenue au client').toContain('ECHO:PING');
  }, 60_000);

  it("-L : le témoin — sans service en face, la connexion n’est pas établie", async () => {
    const { client } = lab();
    await sshWith(client, `-L 15001:${SRV}:9999`);

    const sock = await connected(client, '127.0.0.1', 15001);
    // Sans ce cas, « ça relaie » ne dirait pas que le relais VÉRIFIE
    // l'autre bout : un pont qui accepte tout aurait passé le premier.
    expect(sock.state).not.toBe('established');
  }, 60_000);

  it('-R : le port ouvert sur le SERVEUR est composé depuis le client', async () => {
    const { client, server } = lab();
    // `-R` renverse qui écoute, donc aussi qui compose : c'est le CLIENT
    // qui ouvre la patte lointaine, vers son propre 127.0.0.1:9100.
    const recu = echoService(client, 9100);
    await sshWith(client, '-R 15100:127.0.0.1:9100');

    const sock = await connected(server, '127.0.0.1', 15100);
    expect(sock.state).toBe('established');
    const repondu: string[] = [];
    sock.onData((d) => repondu.push(d));
    sock.send('REV');
    for (let i = 0; i < 60 && repondu.length === 0; i++) await tick();

    expect(recu.join('')).toContain('REV');
    expect(repondu.join('')).toContain('ECHO:REV');
  }, 60_000);

  it('-D : le proxy SOCKS5 fait composer le serveur et pontent les octets', async () => {
    const { client, server } = lab();
    const recu = echoService(server, 8080);
    await sshWith(client, '-D 1080');

    const sock = await connected(client, '127.0.0.1', 1080);
    expect(sock.state).toBe('established');
    const vu: string[] = [];
    sock.onData((d) => vu.push(d));

    sock.send('\x05\x01\x00');
    for (let i = 0; i < 60 && vu.length === 0; i++) await tick();
    expect(vu.join('')).toBe('\x05\x00');

    // CONNECT ver=5 cmd=1 rsv=0 atyp=1 (IPv4) 10.95.0.20:8080.
    const [a, b, c, d] = SRV.split('.').map(Number);
    sock.send(
      '\x05\x01\x00\x01' +
        String.fromCharCode(a, b, c, d) +
        String.fromCharCode(8080 >> 8, 8080 & 0xff),
    );
    for (let i = 0; i < 60 && vu.join('').length <= 2; i++) await tick();
    const reponse = vu.join('');
    expect(reponse.charCodeAt(2)).toBe(0x05);
    expect(reponse.charCodeAt(3), 'REP=0x00 : le serveur a bien ouvert la patte lointaine').toBe(0x00);

    sock.send('SOCKS');
    for (let i = 0; i < 60 && recu.length === 0; i++) await tick();
    expect(recu.join('')).toContain('SOCKS');
    expect(vu.join('')).toContain('ECHO:SOCKS');
  }, 60_000);
});
