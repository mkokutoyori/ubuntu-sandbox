/**
 * Sonde — `tcp-initial-timeout`, `tcp-idle-timeout`, `tcp-keepalive-timeout` et `tcp-advertised-timeout` de named, et `dig +keepalive`.
 *
 * Mesure (BIND 9.18.39 reel, `tcp-initial-timeout 25; tcp-idle-timeout 10; tcp-keepalive-timeout 40; tcp-advertised-timeout 70;`, un client
 * Python qui garde la connexion ouverte, en TCP clair et en DoT ; unites de 100 ms) :
 *   - une connexion TCP muette est fermee au bout de `tcp-initial-timeout` (2,5 s) ; en DoT, au bout de `tcp-idle-timeout` (1,0 s) ;
 *   - apres une requete, la connexion est fermee `tcp-idle-timeout` apres la derniere (1,0 s) ; chaque requete relance le delai (des
 *     requetes toutes les 0,6 s la gardent ouverte, fermee 1,0 s apres la derniere) ; TCP et DoT font pareil ;
 *   - une requete qui porte l'option EDNS TCP keepalive (RFC 7828, code 11, vide) recoit en reponse l'option avec `tcp-advertised-timeout`
 *     (70, deux octets) et la connexion n'est plus fermee qu'apres `tcp-keepalive-timeout` (4,0 s) ;
 *   - par defaut les quatre valent 300 (30 s) : la reponse annonce 300 ;
 *   - `named-checkconf` accepte tout entier ; au chargement named ramene dans les bornes et journalise
 *     `FICHIER:LIGNE: tcp-initial-timeout value is out of range: raising to 25` (initial 25..1200, idle 1..1200, keepalive 1..65535,
 *     advertised 0..65535 ; la graphie du message pour le dernier est « tcp-advertized-timeout », celle du programme) ; une valeur qui n'est pas
 *     un entier donne `expected number near 'X'` ;
 *   - `dig +tcp +keepalive` affiche `; TCP KEEPALIVE: 30.0 secs` apres la ligne EDNS (valeur / 10 `.` valeur % 10) ; sur UDP, avec `+nokeepalive`
 *     ou avec `+noedns` (qui l'emporte), aucune ligne.
 *   Non mesure : DoH (le delai d'inactivite d'une connexion HTTP/2), `tcp-clients`.
 *
 * Avant la correction (git stash push -- src/network) : 30 cas sur 36 tombent (les quatre options etaient refusees « unknown option », le serveur DoT n'avait
 * aucun delai, le serveur TCP une constante de 10 s, l'option keepalive n'existait pas). Passent des deux cotes : les deux temoins (sans delai configure,
 * une requete recoit sa reponse en TCP et en DoT) et les quatre cas ou rien ne doit s'afficher (`+keepalive` sur UDP, `+nokeepalive`, sans `+keepalive`,
 * `+noedns`), qui ne peuvent pas tomber puisque le simulateur n'ecrivait jamais la ligne. Les cas « dans les bornes » portent un temoin : named doit repondre.
 */
import { describe, it, expect } from 'vitest';
import { buildLegacyQueryMessage } from '@/network/dns/compat/DnsWireCompat';
import { decodeDnsMessage, encodeDnsMessage } from '@/network/dns/wire/DnsMessageCodec';
import { DnsStreamReader, frameDnsMessage } from '@/network/dns/transport/DnsStreamFraming';
import { tcpKeepaliveOption, tcpKeepaliveUnits } from '@/network/dns/wire/EdnsOptRecord';
import type { DnsMessage } from '@/network/dns/wire/DnsMessage';
import type { TcpSocket } from '@/network/tcp/TcpStack';
import { CertificateVerifier } from '@/network/pki/CertificateVerifier';
import { TlsClientSession } from '@/network/tls/TlsClientSession';
import { TlsClientChannel } from '@/network/tls/TlsClientChannel';
import type { TlsRecord } from '@/network/tls/recordLayer';
import { runTlsHandshakeOverSocket } from '@/network/http/https/TlsRecordWire';
import { lab, writeRoot, SERVER_IP } from './_bind9-tls-lab';

const LONG = 120_000;
const TIMEOUTS = 'tcp-initial-timeout 25; tcp-idle-timeout 10; tcp-keepalive-timeout 40; tcp-advertised-timeout 70;';
const LISTEN = 'listen-on { any; }; listen-on port 853 tls local-tls { any; }; recursion no;';

interface Connection {
  readonly closedAfter: () => number | null;
  readonly send: (keepalive: boolean) => void;
  readonly replies: DnsMessage[];
  readonly socket: TcpSocket;
}

const pause = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function query(id: number, keepalive: boolean): Uint8Array {
  const message = buildLegacyQueryMessage(id, 'banquehorizon.com', 'SOA', {
    recursionDesired: false, udpPayloadSize: 1232, ...(keepalive ? { ednsOptions: [tcpKeepaliveOption()] } : {}),
  });
  return frameDnsMessage(encodeDnsMessage(message!));
}

async function connect(pc: { tcpConnect: (ip: string, port: number) => Promise<TcpSocket | null>; getTcpStack: () => { nowMs(): number } }, dot: boolean): Promise<Connection> {
  const socket = (await pc.tcpConnect(SERVER_IP, dot ? 853 : 53))!;
  expect(socket).not.toBeNull();
  const startedAt = Date.now();
  let closedAt: number | null = null;
  socket.onClose(() => { closedAt = Date.now(); });
  const replies: DnsMessage[] = [];
  const reader = new DnsStreamReader();
  let next = 1;
  if (!dot) {
    socket.onData((data) => {
      if (data instanceof Uint8Array) for (const raw of reader.push(data)) replies.push(decodeDnsMessage(raw));
    });
    return { socket, replies, closedAfter: () => (closedAt === null ? null : closedAt - startedAt), send: (keepalive) => { socket.send(query(next++, keepalive)); } };
  }
  const client = new TlsClientSession({
    verifier: new CertificateVerifier({ trustAnchors: [], clock: () => pc.getTcpStack().nowMs() }), alpn: ['dot'], allowUntrustedPeer: true,
  });
  const trailing: TlsRecord[] = [];
  runTlsHandshakeOverSocket(socket, client, (records) => { trailing.push(...records); });
  expect(client.result).toBe('success');
  const channel = new TlsClientChannel(socket, client);
  channel.onPushBytes((plaintext) => { for (const raw of reader.push(plaintext)) replies.push(decodeDnsMessage(raw)); });
  if (trailing.length > 0) channel.receiveRecords(trailing);
  return { socket, replies, closedAfter: () => (closedAt === null ? null : closedAt - startedAt), send: (keepalive) => channel.send(query(next++, keepalive)) };
}

async function timed(options: string) {
  const context = await lab();
  await context.start(`options { ${LISTEN} ${options} };`);
  return context;
}

describe.each([['TCP', false], ['DoT', true]] as const)('%s : les delais du serveur', (_name, dot) => {
  it('temoin : sans delai configure, une requete recoit sa reponse', async () => {
    const { pc } = await timed('');
    const connection = await connect(pc, dot);
    connection.send(false);
    await pause(300);
    expect(connection.replies).toHaveLength(1);
    expect(connection.closedAfter()).toBeNull();
    connection.socket.close();
  }, LONG);

  it('apres une requete, la connexion est fermee tcp-idle-timeout apres la derniere', async () => {
    const { pc } = await timed(TIMEOUTS);
    const connection = await connect(pc, dot);
    connection.send(false);
    await pause(500);
    expect(connection.replies).toHaveLength(1);
    expect(connection.closedAfter()).toBeNull();
    await pause(1000);
    expect(connection.closedAfter()).not.toBeNull();
    expect(connection.closedAfter()!).toBeLessThan(2000);
  }, LONG);

  it('chaque requete relance le delai', async () => {
    const { pc } = await timed(TIMEOUTS);
    const connection = await connect(pc, dot);
    for (let round = 0; round < 4; round++) {
      connection.send(false);
      await pause(600);
    }
    expect(connection.replies).toHaveLength(4);
    expect(connection.closedAfter()).toBeNull();
    await pause(900);
    expect(connection.closedAfter()).not.toBeNull();
  }, LONG);

  it('l\'option keepalive recoit tcp-advertised-timeout et allonge le delai a tcp-keepalive-timeout', async () => {
    const { pc } = await timed(TIMEOUTS);
    const connection = await connect(pc, dot);
    connection.send(true);
    await pause(300);
    expect(connection.replies.map(tcpKeepaliveUnits)).toEqual([70]);
    await pause(2200);
    expect(connection.closedAfter()).toBeNull();
    await pause(2200);
    expect(connection.closedAfter()).not.toBeNull();
  }, LONG);

  it('sans l\'option keepalive dans la requete, la reponse n\'en porte pas', async () => {
    const { pc } = await timed(TIMEOUTS);
    const connection = await connect(pc, dot);
    connection.send(false);
    await pause(300);
    expect(connection.replies.map(tcpKeepaliveUnits)).toEqual([null]);
    connection.socket.close();
  }, LONG);
});

describe('une connexion muette', () => {
  it('TCP : fermee au bout de tcp-initial-timeout', async () => {
    const { pc } = await timed(TIMEOUTS);
    const connection = await connect(pc, false);
    await pause(1800);
    expect(connection.closedAfter()).toBeNull();
    await pause(1500);
    expect(connection.closedAfter()).not.toBeNull();
  }, LONG);

  it('DoT : fermee au bout de tcp-idle-timeout', async () => {
    const { pc } = await timed(TIMEOUTS);
    const connection = await connect(pc, true);
    await pause(1600);
    expect(connection.closedAfter()).not.toBeNull();
    expect(connection.closedAfter()!).toBeLessThan(1600);
  }, LONG);
});

describe('les valeurs par defaut', () => {
  it('la reponse annonce 300 (30,0 secondes), dig l\'affiche', async () => {
    const { dig } = await timed('');
    const output = await dig('+tcp +keepalive banquehorizon.com SOA');
    expect(output).toContain('; EDNS: version: 0, flags:; udp: 1232\n; TCP KEEPALIVE: 30.0 secs');
  }, LONG);
});

describe('dig +keepalive', () => {
  it('affiche la valeur annoncee, au dixieme de seconde', async () => {
    const { dig } = await timed('tcp-advertised-timeout 75;');
    expect(await dig('+tcp +keepalive banquehorizon.com SOA')).toContain('; TCP KEEPALIVE: 7.5 secs');
  }, LONG);

  it.each([
    ['sur UDP', '+keepalive'],
    ['avec +nokeepalive', '+tcp +nokeepalive'],
    ['sans +keepalive', '+tcp'],
  ])('rien %s', async (_name, flags) => {
    const { dig } = await timed('');
    expect(await dig(`${flags} banquehorizon.com SOA`)).not.toContain('KEEPALIVE');
  }, LONG);

  it('+noedns l\'emporte', async () => {
    const { dig } = await timed('');
    const output = await dig('+tcp +keepalive +noedns banquehorizon.com SOA');
    expect(output).toContain('ANSWER: 1');
    expect(output).not.toContain('OPT PSEUDOSECTION');
    expect(output).not.toContain('KEEPALIVE');
  }, LONG);
});

describe('les bornes', () => {
  it.each([
    ['tcp-initial-timeout 24', 'tcp-initial-timeout value is out of range: raising to 25'],
    ['tcp-initial-timeout 1201', 'tcp-initial-timeout value is out of range: lowering to 1200'],
    ['tcp-idle-timeout 0', 'tcp-idle-timeout value is out of range: raising to 1'],
    ['tcp-idle-timeout 1201', 'tcp-idle-timeout value is out of range: lowering to 1200'],
    ['tcp-keepalive-timeout 0', 'tcp-keepalive-timeout value is out of range: raising to 1'],
    ['tcp-keepalive-timeout 65536', 'tcp-keepalive-timeout value is out of range: lowering to 65535'],
    ['tcp-advertised-timeout 65536', 'tcp-advertized-timeout value is out of range: lowering to 65535'],
  ])('%s est ramene dans les bornes et journalise', async (option, message) => {
    const { server } = await timed(`${option};`);
    expect(await server.executeCommand('cat /var/log/syslog')).toContain(`/etc/bind/named.conf:2: ${message}`);
  }, LONG);

  it.each([
    'tcp-initial-timeout 25', 'tcp-initial-timeout 1200', 'tcp-idle-timeout 1', 'tcp-idle-timeout 1200',
    'tcp-keepalive-timeout 1', 'tcp-keepalive-timeout 65535', 'tcp-advertised-timeout 0', 'tcp-advertised-timeout 1201',
  ])('temoin : %s est dans les bornes, named repond et rien n\'est journalise', async (option) => {
    const { server, dig } = await timed(`${option};`);
    expect(await dig('banquehorizon.com SOA +short')).toContain('ns1.banquehorizon.com.');
    expect(await server.executeCommand('cat /var/log/syslog')).not.toContain('out of range');
  }, LONG);

  it.each(['abc', '-1', '1.5'])('une valeur illisible (%s) est refusee', async (value) => {
    const { server } = await lab();
    writeRoot(server, '/etc/bind/named.conf', `options {\n tcp-idle-timeout ${value};\n};\n`);
    expect(await server.executeCommand('named-checkconf')).toBe(`/etc/bind/named.conf:2: expected number near '${value}'`);
  }, LONG);
});
