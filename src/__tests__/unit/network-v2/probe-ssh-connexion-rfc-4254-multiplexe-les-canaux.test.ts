/*
 * Sonde -- la couche connexion de la RFC 4254 : des canaux multiplexes sur
 * un transport, avec fenetre, paquets bornes, EOF/CLOSE et requetes.
 *
 * MESURE DE DEPART. Le simulateur n'avait AUCUN canal SSH : un « canal »
 * etait un entier dans une enveloppe JSON `{"op":"open_channel"}' portee
 * par le message local 192, sans fenetre, sans taille de paquet, sans
 * EOF, et sans aucun des messages 80 a 100 de la RFC 4254. Ce lot ajoute
 * `SshConnection' ; l'ancien chemin JSON disparait aux lots suivants.
 *
 * AUTORITES. RFC 4254 §4 (requetes globales : REQUEST_SUCCESS/FAILURE),
 * §5.1 (ouverture : fenetre initiale et taille maximale de paquet,
 * OPEN_FAILURE et ses quatre codes), §5.2 (DATA / EXTENDED_DATA, la
 * fenetre est consommee par chaque octet), §5.3 (EOF puis CLOSE ; chaque
 * cote repond CLOSE), §5.4 (requetes de canal : les reponses partent
 * DANS L'ORDRE des requetes). OpenSSH 8.9p1 `channels.c' pour la politique
 * de WINDOW_ADJUST (`channel_check_window') et la deconnexion sur un canal
 * inexistant (« packet referred to nonexistent channel »), `PROTOCOL' pour
 * keepalive@openssh.com (le serveur repond REQUEST_FAILURE).
 *
 * Eprouve HORS DEPOT contre l'`ssh' 8.9p1 REEL compile depuis les sources,
 * sur une vraie socket : exec avec stdout/stderr separes et exit-status 7 ;
 * 600 Kio sortants et 900 Kio entrants ET sortants (fenetre ajustee dans
 * les deux sens) ; ServerAliveInterval=1 pendant 3,5 s ; -L (canal
 * direct-tcpip, originateur 127.0.0.1) ; -R (tcpip-forward puis canal
 * forwarded-tcpip ouvert par le serveur) -- chaque octet ressort intact.
 *
 * Module NOUVEAU : un `git stash' des fichiers suivis ne le retire pas, la
 * discrimination avant/apres se mesure aux lots suivants, ou ces canaux
 * remplacent le JSON. TEMOIN : l'ouverture d'un canal `session' est
 * confirmee et une donnee le traverse intacte -- il prouve que le
 * laboratoire (deux transports reels relies en memoire) est sain.
 */
import { describe, it, expect } from 'vitest';
import type { TcpStream } from '@/network/tcp/types';
import { SshTransport } from '@/network/protocols/ssh/transport/SshTransport';
import { SshHostKey } from '@/network/protocols/ssh/SshHostKey';
import { keygenPrivateKey } from '@/network/devices/linux/network/SshKeygenMaterial';
import { base64ToBytes, bytesToUtf8 } from '@/crypto/encoding';
import { SshConnection, SshOpenFailure, type ConnectionChannel } from '@/network/protocols/ssh/connection/SshConnection';
import { decodeConnectionMessage } from '@/network/protocols/ssh/connection/ConnectionMessages';
import { decodeStringPayload, encodeExitStatus, decodeExitStatus } from '@/network/protocols/ssh/connection/ChannelPayloads';

function pipePair(): [TcpStream, TcpStream] {
  const make = (): { stream: TcpStream; deliver: (d: string) => void; end: () => void; peer: { write?: (d: string) => void; end?: () => void } } => {
    const handlers: Array<(d: string) => void> = [];
    const unread: string[] = [];
    const closers: Array<(r: string) => void> = [];
    const peer: { write?: (d: string) => void; end?: () => void } = {};
    return {
      peer,
      deliver: (d) => { if (handlers.length === 0) unread.push(d); else for (const h of [...handlers]) h(d); },
      end: () => { for (const c of [...closers]) c('fin'); },
      stream: {
        localIp: '10.0.0.1', localPort: 1, remoteIp: '10.0.0.2', remotePort: 22,
        write: (d: string) => peer.write?.(d),
        close: () => { peer.end?.(); },
        onData: (h) => { handlers.push(h); for (const u of unread.splice(0)) h(u); return () => {}; },
        onClose: (h) => { closers.push(h); return () => {}; },
      } as TcpStream,
    };
  };
  const a = make();
  const b = make();
  a.peer.write = b.deliver;
  b.peer.write = a.deliver;
  a.peer.end = b.end;
  b.peer.end = a.end;
  return [a.stream, b.stream];
}

async function lab(serverOptions: { windowSize?: number } = {}): Promise<{
  client: SshConnection; server: SshConnection; clientTransport: SshTransport; serverTransport: SshTransport;
  wire: Uint8Array[];
}> {
  const hostKey = SshHostKey.generate('srv', 'ssh-ed25519');
  const privateKey = keygenPrivateKey(hostKey.privateKeyBlob)!;
  const [clientSide, serverSide] = pipePair();
  const wire: Uint8Array[] = [];
  const serverTransport = new SshTransport(serverSide, {
    role: 'server', identification: 'SSH-2.0-probe-server',
    hostKeys: [{ publicKeyBlob: base64ToBytes(hostKey.publicKey), privateKey }],
  });
  const clientTransport = new SshTransport(clientSide, { role: 'client', identification: 'SSH-2.0-probe-client' });
  expect((await clientTransport.established).ok).toBe(true);
  const client = new SshConnection(clientTransport);
  const server = new SshConnection(serverTransport, serverOptions);
  serverTransport.onMessage((p) => wire.push(p));
  clientTransport.onMessage((p) => wire.push(p));
  return { client, server, clientTransport, serverTransport, wire };
}

function accepting(server: SshConnection, onChannel: (c: ConnectionChannel) => void): void {
  server.onChannelOpen('session', (incoming) => onChannel(incoming.accept()));
}

describe('RFC 4254 -- canaux multiplexes', () => {
  it('TEMOIN -- un canal session est confirme et une donnee le traverse intacte', async () => {
    const { client, server } = await lab();
    const got: string[] = [];
    accepting(server, (c) => c.onData((d) => got.push(bytesToUtf8(d))));
    const channel = await client.openChannel('session');
    channel.write('bonjour');

    expect(channel.isOpen).toBe(true);
    expect(got).toEqual(['bonjour']);
  });

  it('un type de canal inconnu est refuse avec le code 3 (UNKNOWN_CHANNEL_TYPE)', async () => {
    const { client } = await lab();

    await expect(client.openChannel('x11')).rejects.toMatchObject({ reason: 3, description: 'unsupported channel type' });
  });

  it('un refus du serveur porte son code et son texte', async () => {
    const { client, server } = await lab();
    server.onChannelOpen('direct-tcpip', (incoming) => incoming.reject(1, 'administratively prohibited: open failed'));

    const failure = await client.openChannel('direct-tcpip').catch((e) => e as SshOpenFailure);

    expect(failure).toBeInstanceOf(SshOpenFailure);
    expect(failure).toMatchObject({ reason: 1, description: 'administratively prohibited: open failed' });
  });

  it('la fenetre initiale est 2 Mio et la taille de paquet 32 Kio, comme OpenSSH', async () => {
    const { client, server, wire } = await lab();
    accepting(server, () => undefined);
    await client.openChannel('session');
    const open = wire.map((p) => decodeConnectionMessage(p)).find((m) => m?.kind === 'channel-open');

    expect(open).toMatchObject({ initialWindow: 2097152, maxPacket: 32768 });
  });

  it('les donnees sont decoupees en paquets de 32 Kio au plus', async () => {
    const { client, server, wire } = await lab();
    accepting(server, () => undefined);
    const channel = await client.openChannel('session');
    channel.write(new Uint8Array(100_000));
    const sizes = wire.map((p) => decodeConnectionMessage(p)).filter((m) => m?.kind === 'data')
      .map((m) => (m as { data: Uint8Array }).data.length);

    expect(sizes).toEqual([32768, 32768, 32768, 1696]);
  });

  it('au-dela de la fenetre l\'emetteur attend un WINDOW_ADJUST, puis reprend', async () => {
    const { client, server } = await lab();
    let received = 0;
    accepting(server, (c) => { c.onData((d) => { received += d.length; }); });
    const channel = await client.openChannel('session');
    channel.write(new Uint8Array(5_000_000));

    expect(received).toBe(5_000_000);
    expect(channel.peerWindow).toBeGreaterThan(0);
  });

  it('un pair qui depasse sa fenetre est deconnecte (« rcvd too much data »)', async () => {
    const { client, server, serverTransport } = await lab({ windowSize: 1000 });
    accepting(server, () => undefined);
    const channel = await client.openChannel('session');
    const reasons: string[] = [];
    serverTransport.onClose((r) => reasons.push(r));
    (channel as unknown as { remoteWindow: number }).remoteWindow = 10_000;
    channel.write(new Uint8Array(5000));

    expect(reasons.join(' ')).toContain('rcvd too much data');
  });

  it('EOF puis CLOSE : chaque cote repond CLOSE et le canal est libere des deux', async () => {
    const { client, server } = await lab();
    const log: string[] = [];
    let serverSide: ConnectionChannel | null = null;
    accepting(server, (c) => { serverSide = c; c.onEof(() => log.push('server-eof')); c.onClose(() => log.push('server-close')); });
    const channel = await client.openChannel('session');
    channel.onClose(() => log.push('client-close'));
    channel.eof();
    channel.close();

    expect([...log].sort()).toEqual(['client-close', 'server-close', 'server-eof']);
    expect(client.channelCount).toBe(0);
    expect(server.channelCount).toBe(0);
    expect(serverSide!.isOpen).toBe(false);
  });

  it('les reponses de requetes de canal partent dans l\'ordre des requetes', async () => {
    const { client, server } = await lab();
    const late: Array<() => void> = [];
    accepting(server, (c) => c.onRequest((request) => {
      if (request.name === 'slow') late.push(() => request.reply(true));
      else request.reply(false);
    }));
    const channel = await client.openChannel('session');
    const order: string[] = [];
    void channel.request('slow', undefined, true).then((ok) => order.push(`slow:${ok}`));
    void channel.request('fast', undefined, true).then((ok) => order.push(`fast:${ok}`));
    late.forEach((release) => release());
    await Promise.resolve();

    expect(order).toEqual(['slow:true', 'fast:false']);
  });

  it('exit-status et le texte d\'une requete exec voyagent comme des chaines SSH', async () => {
    const { client, server } = await lab();
    const commands: string[] = [];
    accepting(server, (c) => c.onRequest((request) => {
      if (request.name !== 'exec') return request.reply(false);
      commands.push(decodeStringPayload(request.payload)!);
      request.reply(true);
      void c.request('exit-status', encodeExitStatus(3));
    }));
    const channel = await client.openChannel('session');
    const statuses: number[] = [];
    channel.onRequest((request) => { statuses.push(decodeExitStatus(request.payload)!); });
    const accepted = await channel.request('exec', new Uint8Array([0, 0, 0, 2, 0x6c, 0x73]), true);

    expect(accepted).toBe(true);
    expect(commands).toEqual(['ls']);
    expect(statuses).toEqual([3]);
  });

  it('une requete globale inconnue recoit REQUEST_FAILURE, keepalive@openssh.com compris', async () => {
    const { client } = await lab();

    expect(await client.globalRequest('keepalive@openssh.com')).toBeNull();
    expect(await client.globalRequest('no-such-request@example.com')).toBeNull();
  });

  it('un message sur un canal inexistant deconnecte, comme channels.c', async () => {
    const { clientTransport, serverTransport } = await lab();
    const reasons: string[] = [];
    serverTransport.onClose((r) => reasons.push(r));
    clientTransport.send(new Uint8Array([94, 0, 0, 0, 42, 0, 0, 0, 0]));

    expect(reasons.join(' ')).toContain('data packet referred to nonexistent channel 42');
  });
});
