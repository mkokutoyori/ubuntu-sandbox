/**
 * Sonde — les redirections de ports et SFTP voyagent dans des CANAUX de la
 * RFC 4254, avec les attributs SFTP v3 que lit un vrai client OpenSSH.
 *
 * Ce qui existait : `-L`/`-D` faisaient composer la cible par la pile TCP du
 * SERVEUR directement (un `dialDevice` tendu au redirecteur) et `-R` posait
 * l'ecoute en atteignant l'objet distant ; aucun message SSH ne portait
 * l'ouverture. SFTP parlait un JSON local `\0`-etiquete, et ses attributs
 * melangeaient les bits de la v3 avec ceux d'un brouillon v4-v6, si bien
 * qu'un vrai `sftp` repondait `do_lsreaddir: parse filenames: incomplete
 * message`.
 *
 * Mesure : sur la base `origin/mandeng` du lot le fichier ne se charge meme
 * pas (`ConnectionMessages` et `tunnelThroughSession` n'y existent pas), donc
 * les 19 cas tombent -- une mesure cas par cas est impossible, et c'est dit
 * plutot que suggere. Ce que la lecture de la base etablit, cas par cas :
 *   - « le temoin » (session + exec, aucun canal de redirection) et « sans
 *     service en face, la connexion locale est refermee » passeraient a
 *     l'identique : le labo est sain et l'ancien raccourci refermait deja ;
 *   - tous les autres exigent un message `direct-tcpip` / `tcpip-forward` /
 *     `forwarded-tcpip` sur la connexion, ou la disposition v3 des
 *     attributs, qui n'existaient pas.
 * Les attentes sont ecrites en dur (numeros de message 80/90, drapeau
 * 0x80000000, format `ls -l`), pas calculees par le code sous test.
 * Autorite : RFC 4254 §6.5 (subsystem), §7.1 (tcpip-forward), §7.2
 * (direct-tcpip, forwarded-tcpip) ; draft-ietf-secsh-filexfer-02 §5 pour la
 * disposition des attributs v3, telle que la lit sftp-client.c d'OpenSSH.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { resetCounters, MACAddress } from '@/network/core/types';
import { Logger } from '@/network/core/Logger';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import { SshTransport } from '@/network/protocols/ssh/transport/SshTransport';
import { SshLocalForwarder } from '@/network/protocols/ssh/SshLocalForwarder';
import { SshRemoteForwarder } from '@/network/protocols/ssh/SshRemoteForwarder';
import { SshDynamicForwarder } from '@/network/protocols/ssh/SshDynamicForwarder';
import { tunnelThroughSession } from '@/network/protocols/ssh/forwardRelay';
import { decodeConnectionMessage } from '@/network/protocols/ssh/connection/ConnectionMessages';
import { decodeDirectTcpip, decodeForwardedTcpip, decodeTcpipForward } from '@/network/protocols/ssh/connection/ChannelPayloads';
import { SftpWireSession } from '@/network/protocols/ssh/sftp/SftpWireSession';
import { LinuxSftpFSAdapter } from '@/network/protocols/ssh/sftp/LinuxSftpFSAdapter';
import { SshUserContext } from '@/network/protocols/ssh/SshUserContext';
import { VirtualFileSystem } from '@/network/devices/linux/VirtualFileSystem';
import { encodeSftpWirePacket, decodeSftpWirePacket } from '@/network/protocols/ssh/sftp/SftpWireCodec';
import { buildLan, assignIps, openSshSession, sshExec, PC1_IP, PC2_IP, PC3_IP, type SshLan } from './ssh-lan-fixtures';

const tick = (ms = 20) => new Promise<void>((resolve) => setTimeout(resolve, ms));

interface Seen { role: 'client' | 'server'; message: NonNullable<ReturnType<typeof decodeConnectionMessage>> }

function observeConnectionMessages(): Seen[] {
  const seen: Seen[] = [];
  const send = SshTransport.prototype.send;
  vi.spyOn(SshTransport.prototype, 'send').mockImplementation(function (this: SshTransport, payload: Uint8Array) {
    if (payload[0] >= 80 && payload[0] <= 100) {
      const message = decodeConnectionMessage(payload);
      const role = (this as unknown as { config: { role: 'client' | 'server' } }).config.role;
      if (message) seen.push({ role, message });
    }
    send.call(this, payload);
  });
  return seen;
}

function echoService(device: SshLan['pc3'], port: number): { accepted: string[]; received: string[] } {
  const accepted: string[] = [];
  const received: string[] = [];
  device.getTcpStack().listen(port, {
    onAccept: (socket) => {
      accepted.push(socket.remoteIp);
      socket.onData((data) => { received.push(String(data)); socket.send(`ECHO:${String(data)}`); });
    },
  });
  return { accepted, received };
}

async function roundTrip(from: SshLan['pc1'], host: string, port: number, payload: string): Promise<string> {
  const replies: string[] = [];
  const socket = from.getTcpStack().connect(host, port, { onData: (data) => replies.push(String(data)) });
  expect(socket).not.toBeNull();
  for (let i = 0; i < 40 && socket!.state === 'syn-sent'; i++) await tick();
  socket!.send(payload);
  for (let i = 0; i < 40 && replies.length === 0; i++) await tick();
  return replies.join('');
}

function isListening(device: SshLan['pc1'], port: number): boolean {
  return device.getTcpStack().listListeners().some((listener) => listener.localPort === port);
}

let lan: SshLan;

beforeEach(async () => {
  resetCounters();
  MACAddress.resetCounter();
  Logger.reset();
  EquipmentRegistry.getInstance().clear();
  lan = buildLan();
  await assignIps(lan);
});

afterEach(() => { vi.restoreAllMocks(); });

async function restrictForwarding(directive: string): Promise<void> {
  const keyword = directive.split(' ')[0];
  await lan.pc2.executeCommand(`sudo sed -i '/^#\\?${keyword}/d' /etc/ssh/sshd_config`);
  await lan.pc2.executeCommand(`echo "${directive}" | sudo tee -a /etc/ssh/sshd_config`);
  await lan.pc2.executeCommand('sudo systemctl restart ssh');
}

describe('ssh -L : un canal direct-tcpip (RFC 4254 §7.2)', () => {
  it('le temoin — une session s\'ouvre et un exec passe, sans aucun canal de redirection', async () => {
    const seen = observeConnectionMessages();
    const result = await sshExec(lan.pc1, PC2_IP, 'echo up');
    expect(result.stdout).toBe('up\n');
    expect(seen.filter((s) => s.message.kind === 'channel-open' && s.message.channelType === 'direct-tcpip')).toEqual([]);
  });

  it('les octets ecrits sur le port local ressortent chez la cible, que le SERVEUR a composee', async () => {
    const target = echoService(lan.pc3, 8080);
    const session = await openSshSession(lan.pc1, PC2_IP);
    const forwarder = new SshLocalForwarder(lan.pc1, tunnelThroughSession(session), {
      localPort: 9001, remoteHost: PC3_IP, remotePort: 8080, sshHost: PC2_IP,
    });
    expect(forwarder.register()).toBe('opened');

    expect(await roundTrip(lan.pc1, '127.0.0.1', 9001, 'PING')).toBe('ECHO:PING');
    expect(target.received).toEqual(['PING']);
    expect(target.accepted).toEqual([PC2_IP]);
    session.disconnect();
  });

  it('le client envoie un CHANNEL_OPEN direct-tcpip qui nomme la cible', async () => {
    echoService(lan.pc3, 8080);
    const seen = observeConnectionMessages();
    const session = await openSshSession(lan.pc1, PC2_IP);
    new SshLocalForwarder(lan.pc1, tunnelThroughSession(session), {
      localPort: 9002, remoteHost: PC3_IP, remotePort: 8080, sshHost: PC2_IP,
    }).register();
    await roundTrip(lan.pc1, '127.0.0.1', 9002, 'x');

    const opens = seen.filter((s) => s.role === 'client' && s.message.kind === 'channel-open' && s.message.channelType === 'direct-tcpip');
    expect(opens).toHaveLength(1);
    const open = opens[0].message as Extract<Seen['message'], { kind: 'channel-open' }>;
    expect(decodeDirectTcpip(open.payload)).toMatchObject({ host: PC3_IP, port: 8080 });
    session.disconnect();
  });

  it('sans service en face, le serveur refuse le canal en CONNECT_FAILED et la connexion locale est refermee', async () => {
    const session = await openSshSession(lan.pc1, PC2_IP);
    const lines: string[] = [];
    new SshLocalForwarder(lan.pc1, tunnelThroughSession(session, (line) => lines.push(line)), {
      localPort: 9003, remoteHost: PC3_IP, remotePort: 9999, sshHost: PC2_IP,
    }).register();
    const socket = lan.pc1.getTcpStack().connect('127.0.0.1', 9003)!;
    for (let i = 0; i < 40 && socket.state !== 'closed'; i++) await tick();
    expect(socket.state).not.toBe('established');
    expect(lines).toEqual(['channel 0: open failed: connect failed: Connection refused']);
    session.disconnect();
  });

  it('AllowTcpForwarding no : le serveur refuse le canal, administrativement', async () => {
    await restrictForwarding('AllowTcpForwarding no');
    echoService(lan.pc3, 8080);
    const session = await openSshSession(lan.pc1, PC2_IP);
    const lines: string[] = [];
    new SshLocalForwarder(lan.pc1, tunnelThroughSession(session, (line) => lines.push(line)), {
      localPort: 9004, remoteHost: PC3_IP, remotePort: 8080, sshHost: PC2_IP,
    }).register();
    const socket = lan.pc1.getTcpStack().connect('127.0.0.1', 9004)!;
    for (let i = 0; i < 40 && socket.state !== 'closed'; i++) await tick();
    expect(lines).toEqual(['channel 0: open failed: administratively prohibited: open failed']);
    session.disconnect();
  });
});

describe('ssh -D : SOCKS5 sur direct-tcpip', () => {
  it('CONNECT est repondu apres l\'ouverture du canal et les octets traversent', async () => {
    const target = echoService(lan.pc3, 8081);
    const session = await openSshSession(lan.pc1, PC2_IP);
    const forwarder = new SshDynamicForwarder(lan.pc1, tunnelThroughSession(session), {
      socksPort: 1080, bindAddress: null, sshHost: PC2_IP,
    });
    expect(forwarder.register()).toBe('opened');

    const replies: string[] = [];
    const socket = lan.pc1.getTcpStack().connect('127.0.0.1', 1080, { onData: (data) => replies.push(String(data)) })!;
    for (let i = 0; i < 40 && socket.state === 'syn-sent'; i++) await tick();
    socket.send('\x05\x01\x00');
    await tick();
    expect(replies[0]).toBe('\x05\x00');
    const ip = PC3_IP.split('.').map((part) => String.fromCharCode(Number(part))).join('');
    socket.send(`\x05\x01\x00\x01${ip}${String.fromCharCode(8081 >> 8)}${String.fromCharCode(8081 & 0xff)}`);
    for (let i = 0; i < 40 && replies.length < 2; i++) await tick();
    expect(replies[1]).toBe('\x05\x00\x00\x01\x00\x00\x00\x00\x00\x00');
    socket.send('hello');
    for (let i = 0; i < 40 && replies.length < 3; i++) await tick();
    expect(replies[2]).toBe('ECHO:hello');
    expect(target.accepted).toEqual([PC2_IP]);
    session.disconnect();
  });
});

describe('ssh -R : tcpip-forward puis forwarded-tcpip (RFC 4254 §7.1)', () => {
  it('le client demande l\'ecoute par une requete globale et le serveur la pose', async () => {
    const seen = observeConnectionMessages();
    const session = await openSshSession(lan.pc1, PC2_IP);
    const forwarder = new SshRemoteForwarder(session, lan.pc1, {
      remotePort: 9100, localHost: PC3_IP, localPort: 8082, sshHost: PC2_IP,
    });
    expect(await forwarder.register()).toBe(true);

    const requests = seen.filter((s) => s.role === 'client' && s.message.kind === 'global-request');
    expect(requests).toHaveLength(1);
    const request = requests[0].message as Extract<Seen['message'], { kind: 'global-request' }>;
    expect(request.name).toBe('tcpip-forward');
    expect(decodeTcpipForward(request.payload)).toEqual({ address: 'localhost', port: 9100 });
    expect(isListening(lan.pc2, 9100)).toBe(true);
    expect(isListening(lan.pc1, 9100)).toBe(false);
    session.disconnect();
  });

  it('une connexion au port du serveur arrive chez la cible, que le CLIENT a composee', async () => {
    const target = echoService(lan.pc3, 8082);
    const seen = observeConnectionMessages();
    const session = await openSshSession(lan.pc1, PC2_IP);
    await new SshRemoteForwarder(session, lan.pc1, {
      remotePort: 9101, localHost: PC3_IP, localPort: 8082, sshHost: PC2_IP,
    }).register();

    expect(await roundTrip(lan.pc2, '127.0.0.1', 9101, 'PONG')).toBe('ECHO:PONG');
    expect(target.accepted).toEqual([PC1_IP]);
    const opens = seen.filter((s) => s.role === 'server' && s.message.kind === 'channel-open' && s.message.channelType === 'forwarded-tcpip');
    expect(opens).toHaveLength(1);
    const open = opens[0].message as Extract<Seen['message'], { kind: 'channel-open' }>;
    expect(decodeForwardedTcpip(open.payload)).toMatchObject({ connectedAddress: 'localhost', connectedPort: 9101 });
    session.disconnect();
  });

  it('AllowTcpForwarding local : la requete est refusee et aucune ecoute n\'apparait', async () => {
    await restrictForwarding('AllowTcpForwarding local');
    const session = await openSshSession(lan.pc1, PC2_IP);
    const forwarder = new SshRemoteForwarder(session, lan.pc1, {
      remotePort: 9102, localHost: PC3_IP, localPort: 8082, sshHost: PC2_IP,
    });
    expect(await forwarder.register()).toBe(false);
    expect(isListening(lan.pc2, 9102)).toBe(false);
    session.disconnect();
  });

  it('GatewayPorts no (defaut) : l\'ecoute est sur la boucle locale ; yes : sur toutes les adresses', async () => {
    const session = await openSshSession(lan.pc1, PC2_IP);
    await new SshRemoteForwarder(session, lan.pc1, { remotePort: 9103, localHost: PC3_IP, localPort: 8082, sshHost: PC2_IP }).register();
    const bound = (port: number) => lan.pc2.getTcpStack().listListeners().find((l) => l.localPort === port)?.localIp;
    expect(bound(9103)).toBe('127.0.0.1');
    session.disconnect();

    await restrictForwarding('GatewayPorts yes');
    const second = await openSshSession(lan.pc1, PC2_IP);
    await new SshRemoteForwarder(second, lan.pc1, { remotePort: 9104, localHost: PC3_IP, localPort: 8082, sshHost: PC2_IP }).register();
    expect(bound(9104)).toBe('0.0.0.0');
    second.disconnect();
  });

  it('cancel-tcpip-forward retire l\'ecoute, et la fin de session aussi', async () => {
    const session = await openSshSession(lan.pc1, PC2_IP);
    const forwarder = new SshRemoteForwarder(session, lan.pc1, {
      remotePort: 9105, localHost: PC3_IP, localPort: 8082, sshHost: PC2_IP,
    });
    await forwarder.register();
    forwarder.dispose();
    await tick();
    expect(isListening(lan.pc2, 9105)).toBe(false);

    await new SshRemoteForwarder(session, lan.pc1, { remotePort: 9106, localHost: PC3_IP, localPort: 8082, sshHost: PC2_IP }).register();
    expect(isListening(lan.pc2, 9106)).toBe(true);
    session.disconnect();
    expect(isListening(lan.pc2, 9106)).toBe(false);
  });
});

describe('SFTP v3 tel que le lit sftp-client.c', () => {
  function build() {
    const vfs = new VirtualFileSystem();
    vfs.mkdirp('/home/alice', 0o755, 1000, 1000);
    vfs.writeFile('/home/alice/hello.txt', 'hello sftp', 1000, 1000, 0o022);
    const session = new SftpWireSession({
      vfs: new LinuxSftpFSAdapter(vfs, 1000, 1000),
      userCtx: new SshUserContext('alice', 1000, 1000, [], '/home/alice'),
      rootPath: '/home/alice',
      accountNames: { user: (uid) => (uid === 1000 ? 'alice' : String(uid)), group: (gid) => (gid === 1000 ? 'alice' : String(gid)) },
    });
    session.handle({ type: 'INIT', version: 3 });
    return session;
  }

  it('VERSION annonce l\'extension statvfs@openssh.com, qui est ce qui permet `df`', () => {
    const reply = build().handle({ type: 'INIT', version: 3 });
    expect(reply).toMatchObject({ type: 'VERSION', version: 3, extensions: [{ name: 'statvfs@openssh.com', data: '2' }] });
  });

  it('les attributs v3 ne portent ni champ de type ni drapeau de brouillon : le type est dans les bits de mode', () => {
    const reply = build().handle({ type: 'LSTAT', requestId: 1, path: '.' });
    const bytes = encodeSftpWirePacket(reply, 3);
    const flags = ((bytes[9] << 24) | (bytes[10] << 16) | (bytes[11] << 8) | bytes[12]) >>> 0;
    expect(flags).toBe(0x0000000f);
    const decoded = decodeSftpWirePacket(bytes, 3) as { attrs: { permissions: number; entryType?: string } };
    expect(decoded.attrs.entryType).toBeUndefined();
    expect(decoded.attrs.permissions & 0o170000).toBe(0o040000);
  });

  it('les attributs etendus v3 utilisent le drapeau 0x80000000', () => {
    const bytes = encodeSftpWirePacket({ type: 'ATTRS', requestId: 1, attrs: { extended: [{ name: 'a', value: 'b' }] } }, 3);
    const flags = ((bytes[9] << 24) | (bytes[10] << 16) | (bytes[11] << 8) | bytes[12]) >>> 0;
    expect(flags).toBe(0x80000000);
    expect(decodeSftpWirePacket(bytes, 3)).toMatchObject({ attrs: { extended: [{ name: 'a', value: 'b' }] } });
  });

  it('READDIR renvoie un longname au format de `ls -l`', () => {
    const session = build();
    const handle = (session.handle({ type: 'OPENDIR', requestId: 1, path: '.' }) as { handle: string }).handle;
    const reply = session.handle({ type: 'READDIR', requestId: 2, handle }) as unknown as { entries: Array<{ filename: string; longname: string }> };
    const file = reply.entries.find((entry) => entry.filename === 'hello.txt')!;
    expect(file.longname).toMatch(/^-rw-r--r-- {3}1 alice {4}alice {10}10 [A-Z][a-z]{2} [ \d]\d [ \d]\d[:\d]{3,4} hello\.txt$/);
  });

  it('OPEN en ecriture sans CREAT sur un fichier absent echoue en NO_SUCH_FILE', () => {
    const reply = build().handle({ type: 'OPEN', requestId: 1, filename: 'ghost.txt', pflags: 0x02, attrs: {} });
    expect(reply).toMatchObject({ type: 'STATUS', code: 2 });
  });

  it('OPEN CREAT|EXCL sur un fichier present echoue en FAILURE', () => {
    const reply = build().handle({ type: 'OPEN', requestId: 1, filename: 'hello.txt', pflags: 0x02 | 0x08 | 0x20, attrs: {} });
    expect(reply).toMatchObject({ type: 'STATUS', code: 4 });
  });

  it('OPEN en ecriture sans TRUNC garde le contenu et ecrase a l\'offset', () => {
    const session = build();
    const handle = (session.handle({ type: 'OPEN', requestId: 1, filename: 'hello.txt', pflags: 0x02, attrs: {} }) as { handle: string }).handle;
    session.handle({ type: 'WRITE', requestId: 2, handle, offset: 0, data: new Uint8Array([74]) });
    session.handle({ type: 'CLOSE', requestId: 3, handle });
    const read = (session.handle({ type: 'OPEN', requestId: 4, filename: 'hello.txt', pflags: 0x01, attrs: {} }) as { handle: string }).handle;
    const data = session.handle({ type: 'READ', requestId: 5, handle: read, offset: 0, length: 64 }) as { data: Uint8Array };
    expect(String.fromCharCode(...data.data)).toBe('Jello sftp');
  });

  it('FSTAT repond avec la taille du tampon d\'un fichier ouvert en ecriture', () => {
    const session = build();
    const handle = (session.handle({ type: 'OPEN', requestId: 1, filename: 'new.txt', pflags: 0x02 | 0x08 | 0x10, attrs: {} }) as { handle: string }).handle;
    session.handle({ type: 'WRITE', requestId: 2, handle, offset: 0, data: new Uint8Array([1, 2, 3, 4, 5]) });
    const reply = session.handle({ type: 'FSTAT', requestId: 3, handle }) as { type: string; attrs?: { size?: number } };
    expect(reply.type === 'ATTRS' ? reply.attrs?.size : reply).toBe(5);
  });
});
