/**
 * Sonde — les options des blocs `tls` et `http` de named agissent, au lieu d'etre lues et rangees.
 *
 * Mesure (BIND 9.18.39, openssl 3.0.13, curl 8.5.0 et trames HTTP/2 brutes, reels) :
 *   ciphers + protocols : `ciphers "ECDHE-RSA-AES128-GCM-SHA256"; protocols { TLSv1.2; }` negocie cette suite en TLS 1.2 et ferme la connexion
 *   (sans alerte) quand le client n'en offre pas d'autre ou veut du TLS 1.3 ;
 *   prefer-server-ciphers : yes choisit dans l'ordre du serveur (AES256 devant AES128) ; no ou absent suit l'ordre du client ;
 *   session-tickets no : plus de ligne « TLS session ticket » en TLS 1.2 ; par defaut named en emet (7200 secondes) ;
 *   dhparam-file : seule la presence du fichier ouvre les suites DHE (« Server Temp Key: DH, 3072 bits » avec un groupe de 3072 bits) ;
 *   sans fichier, DHE-RSA-AES128-GCM-SHA256 est refuse ;
 *   ca-file : le serveur exige un certificat client signe par cette autorite et la presente dans sa chaine (« self-signed certificate in
 *   certificate chain » chez un client qui ne la connait pas) ;
 *   ca-file ou dhparam-file absent ou illisible : named s'arrete sur « loading configuration: failure », sans autre ligne ;
 *   ciphers invalide : named-checkconf dit « 'ciphers' in the 'tls' clause 'NOM' is not a valid cipher list string » a la ligne de l'option ;
 *   listener-clients N : la (N+1)-ieme connexion n'est pas servie tant qu'une autre n'est pas fermee ; 0 veut dire sans limite, 300 par defaut ;
 *   streams-per-connection N : SETTINGS_MAX_CONCURRENT_STREAMS = N (100 par defaut, 2147483647 pour 0) et le flux de trop recoit
 *   RST_STREAM REFUSED_STREAM (7) ;
 *   un listener DoT ne verifie pas l'ALPN : un client qui n'offre pas `dot` est servi quand meme ; un listener DoH ne sert que h2
 *   (un client HTTP/1.1 recoit une connexion fermee) ; `tls none http` sert h2c ;
 *   dig +http-plain[-get] interroge le 80 en h2c (HTTP / HTTP-GET), +https sur un listener sans http dit « ALPN for HTTP/2 failed. »,
 *   sur un port en clair « TLS error. », vers un port ferme « connection refused. » (+tcp et +tls aussi), +http-plain sur un port TLS
 *   « communications error ... end of file ».
 *
 * Avant la correction (git stash push -- src/network src/powershell) : 28 cas sur 29 tombent. Le seul qui passe des deux cotes est
 * « ciphers sans dhparam-file ne rend pas DHE disponible » : un refus (aucun DHE sans parametres), borne par le cas voisin ou
 * dhparam-file ouvre DHE et le fait voir (« Server Temp Key: DH, 3072 bits »). Le DoT du simulateur n'emettait aucun ticket, ne
 * lisait ni ciphers ni dhparam-file ni ca-file, imposait l'ALPN `dot`, et le DoH ne parlait qu'HTTP/1.1.
 * Non mesurable ici : les ecoutes IPv6 (le noyau du banc n'a pas d'interface IPv6), et le journal horodate que dig ecrit sur stderr.
 */
import { describe, it, expect } from 'vitest';
import { IPAddress } from '@/network/core/types';
import { queryDnsOverTls } from '@/network/dns/transport/DnsTlsTransport';
import { buildLegacyQueryMessage } from '@/network/dns/compat/DnsWireCompat';
import { dhParametersToPem, pemToCert } from '@/network/pki/pem';
import { modpGroup } from '@/crypto/dh/modp';
import { HpackContext, encodeHeaderBlock } from '@/network/http/http2/Hpack';
import {
  encodeFrame, decodeFrames, encodeSettingsPayload, decodeSettingsPayload, decodeRstStreamPayload, FLAG_END_HEADERS,
  type Http2Frame,
} from '@/network/http/http2/Http2Frame';
import { bytesToBinaryString, binaryStringToBytes } from '@/crypto/encoding';
import { lab, vfsOf, writeRoot, SERVER_IP, PKI, NAME } from './_bind9-tls-lab';

const LONG = 120_000;
const TLS = (name: string, options = '') => `tls ${name} { key-file "${PKI}/srv.key"; cert-file "${PKI}/srv.pem"; ${options} };`;
const PREFACE = 'PRI * HTTP/2.0\r\n\r\nSM\r\n\r\n';

async function sclient(pc: { executeCommand(command: string): Promise<string> }, port: number, options: string): Promise<string> {
  return pc.executeCommand(`echo | openssl s_client -connect ${SERVER_IP}:${port} ${options}`);
}

const cipherOf = (output: string): string | null => /^    Cipher    : (\S+)/m.exec(output)?.[1] ?? null;

describe('ciphers, protocols et prefer-server-ciphers', () => {
  it('temoin : un listener sans option negocie une suite en TLS 1.2 et emet un ticket', async () => {
    const { start, pc } = await lab();
    await start(`options { listen-on port 9006 tls local-tls { any; }; recursion no; };`);
    const out = await sclient(pc, 9006, '-tls1_2');
    expect(cipherOf(out)).toBe('ECDHE-RSA-AES256-GCM-SHA384');
    expect(out).toContain('TLS session ticket lifetime hint: 7200 (seconds)');
  }, LONG);

  it('ciphers et protocols bornent ce que le serveur accepte', async () => {
    const { start, pc } = await lab();
    await start([
      TLS('t12', 'ciphers "ECDHE-RSA-AES128-GCM-SHA256"; protocols { TLSv1.2; };'),
      `options { listen-on port 9001 tls t12 { any; }; recursion no; };`,
    ].join('\n'));
    expect(cipherOf(await sclient(pc, 9001, '-tls1_2 -cipher ECDHE-RSA-AES128-GCM-SHA256'))).toBe('ECDHE-RSA-AES128-GCM-SHA256');
    expect(cipherOf(await sclient(pc, 9001, ''))).toBe('ECDHE-RSA-AES128-GCM-SHA256');
    expect(await sclient(pc, 9001, '-tls1_2 -cipher AES256-GCM-SHA384')).toContain('Cipher is (NONE)');
    expect(await sclient(pc, 9001, '-tls1_3')).toContain('Cipher is (NONE)');
  }, LONG);

  it('prefer-server-ciphers yes suit l\'ordre du serveur, no ou absent celui du client', async () => {
    const { start, pc } = await lab();
    const ciphers = 'ciphers "AES256-GCM-SHA384:AES128-GCM-SHA256"; protocols { TLSv1.2; };';
    await start([
      TLS('pref', `${ciphers} prefer-server-ciphers yes;`),
      TLS('nopref', `${ciphers} prefer-server-ciphers no;`),
      TLS('absent', ciphers),
      'options { listen-on port 9002 tls pref { any; }; listen-on port 9008 tls nopref { any; }; listen-on port 9009 tls absent { any; }; recursion no; };',
    ].join('\n'));
    const clientOrder = '-tls1_2 -cipher AES128-GCM-SHA256:AES256-GCM-SHA384';
    expect(cipherOf(await sclient(pc, 9002, clientOrder))).toBe('AES256-GCM-SHA384');
    expect(cipherOf(await sclient(pc, 9008, clientOrder))).toBe('AES128-GCM-SHA256');
    expect(cipherOf(await sclient(pc, 9009, clientOrder))).toBe('AES128-GCM-SHA256');
  }, LONG);

  it('un listener sans prefer-server-ciphers suit l\'ordre du client meme sans ciphers', async () => {
    const { start, pc } = await lab();
    await start(`options { listen-on port 9006 tls local-tls { any; }; recursion no; };`);
    expect(cipherOf(await sclient(pc, 9006, '-tls1_2 -cipher AES128-GCM-SHA256:AES256-GCM-SHA384'))).toBe('AES128-GCM-SHA256');
    expect(cipherOf(await sclient(pc, 9006, '-tls1_2 -cipher AES256-GCM-SHA384:AES128-GCM-SHA256'))).toBe('AES256-GCM-SHA384');
  }, LONG);
});

describe('session-tickets et dhparam-file', () => {
  it('session-tickets no retire le ticket, le defaut le garde', async () => {
    const { start, pc } = await lab();
    await start([
      TLS('noticket', 'session-tickets no;'),
      'options { listen-on port 9003 tls noticket { any; }; listen-on port 9006 tls local-tls { any; }; recursion no; };',
    ].join('\n'));
    expect(await sclient(pc, 9003, '-tls1_2')).not.toContain('TLS session ticket');
    expect(await sclient(pc, 9006, '-tls1_2')).toContain('TLS session ticket');
  }, LONG);

  it('DHE n\'est offert qu\'avec dhparam-file, et avec les parametres du fichier', async () => {
    const { start, pc, server } = await lab();
    const group = modpGroup(15)!;
    writeRoot(server, `${PKI}/dh3072.pem`, dhParametersToPem({ prime: group.prime, generator: group.generator }));
    await start([
      TLS('plain'),
      TLS('dhe', 'ciphers "DHE-RSA-AES128-GCM-SHA256"; dhparam-file "/etc/bind/tls/dh3072.pem"; protocols { TLSv1.2; };'),
      'options { listen-on port 9006 tls plain { any; }; listen-on port 9005 tls dhe { any; }; recursion no; };',
    ].join('\n'));
    expect(await sclient(pc, 9006, '-tls1_2 -cipher DHE-RSA-AES128-GCM-SHA256')).toContain('Cipher is (NONE)');
    const out = await sclient(pc, 9005, '-tls1_2 -cipher DHE-RSA-AES128-GCM-SHA256');
    expect(cipherOf(out)).toBe('DHE-RSA-AES128-GCM-SHA256');
    expect(out).toContain('Server Temp Key: DH, 3072 bits');
  }, LONG);

  it('ciphers sans dhparam-file ne rend pas DHE disponible', async () => {
    const { start, pc } = await lab();
    await start([
      TLS('dheonly', 'ciphers "DHE-RSA-AES128-GCM-SHA256"; protocols { TLSv1.2; };'),
      'options { listen-on port 9005 tls dheonly { any; }; recursion no; };',
    ].join('\n'));
    expect(await sclient(pc, 9005, '-tls1_2 -cipher DHE-RSA-AES128-GCM-SHA256')).toContain('Cipher is (NONE)');
  }, LONG);
});

describe('ca-file : certificat client exige', () => {
  it('le serveur presente l\'autorite de ca-file dans sa chaine', async () => {
    const { start, pc } = await lab();
    await start([
      TLS('mutual', `ca-file "${PKI}/ca.pem";`),
      TLS('plain'),
      'options { listen-on port 9004 tls mutual { any; }; listen-on port 9006 tls plain { any; }; recursion no; };',
    ].join('\n'));
    expect(await sclient(pc, 9004, '-tls1_3')).toContain('self-signed certificate in certificate chain');
    expect(await sclient(pc, 9006, '-tls1_3')).toContain('unable to get local issuer certificate');
  }, LONG);
});

describe('ciphers invalide, fichiers absents', () => {
  it('named-checkconf refuse une chaine de suites invalide a la ligne de l\'option', async () => {
    const { server } = await lab();
    writeRoot(server, '/etc/bind/named.conf', 'tls a {\n  key-file "x";\n  cert-file "y";\n  ciphers "NOSUCH";\n};\n');
    expect(await server.executeCommand('named-checkconf'))
      .toBe("/etc/bind/named.conf:4: 'ciphers' in the 'tls' clause 'a' is not a valid cipher list string");
  }, LONG);

  it.each([
    ['ca-file absent', 'ca-file "/nonexistent/ca.pem";'],
    ['ca-file illisible', 'ca-file "/etc/bind/named.conf";'],
    ['dhparam-file absent', 'dhparam-file "/nonexistent/dh.pem";'],
    ['dhparam-file illisible', 'dhparam-file "/etc/bind/named.conf";'],
  ])('%s : named s\'arrete sur « loading configuration: failure »', async (_name, option) => {
    const { server } = await lab();
    writeRoot(server, '/etc/bind/named.conf', [
      TLS('broken', option), 'options { listen-on tls broken { any; }; recursion no; };', '',
    ].join('\n'));
    await server.executeCommand('systemctl start named');
    expect(await server.executeCommand('systemctl is-active named')).toBe('failed');
  }, LONG);
});

interface RawH2 {
  readonly frames: () => Http2Frame[];
  open(streams: number): void;
}

function rawHttp2(pc: { getTcpStack(): { connect(ip: string, port: number): any } }, port: number): RawH2 & { closed: () => boolean; close: () => void } {
  const socket = pc.getTcpStack().connect(SERVER_IP, port);
  let received = new Uint8Array(0);
  let closed = false;
  socket.onData((data: unknown) => {
    const arriving = binaryStringToBytes(String(data));
    const joined = new Uint8Array(received.length + arriving.length);
    joined.set(received);
    joined.set(arriving, received.length);
    received = joined;
  });
  socket.onClose(() => { closed = true; });
  socket.write(PREFACE + bytesToBinaryString(encodeFrame({ type: 'SETTINGS', flags: 0, streamId: 0, payload: encodeSettingsPayload({}) })));
  const block = encodeHeaderBlock(new HpackContext(), [
    [':method', 'GET'], [':scheme', 'http'], [':authority', 'localhost'], [':path', '/dns-query'],
  ]);
  return {
    frames: () => decodeFrames(received).frames,
    open: (streams) => {
      for (let index = 0; index < streams; index++) {
        socket.write(bytesToBinaryString(encodeFrame({ type: 'HEADERS', flags: FLAG_END_HEADERS, streamId: 1 + 2 * index, payload: block })));
      }
    },
    closed: () => closed,
    close: () => { socket.close(); },
  };
}

const HTTP_BLOCK = (options: string) => `http h { endpoints { "/dns-query"; }; ${options} };`;

describe('streams-per-connection et listener-clients', () => {
  const advertised = (frames: Http2Frame[]): number | undefined => {
    const settings = frames.find((frame) => frame.type === 'SETTINGS' && (frame.flags & 1) === 0);
    return settings === undefined ? undefined : decodeSettingsPayload(settings.payload).maxConcurrentStreams;
  };

  it.each([
    ['streams-per-connection 3', 'streams-per-connection 3;', 3],
    ['rien', '', 100],
    ['streams-per-connection 0', 'streams-per-connection 0;', 2147483647],
  ])('%s annonce SETTINGS_MAX_CONCURRENT_STREAMS %d', async (_name, option, expected) => {
    const { start, pc } = await lab();
    await start([HTTP_BLOCK(option), 'options { listen-on port 8080 tls none http h { any; }; recursion no; };'].join('\n'));
    expect(advertised(rawHttp2(pc, 8080).frames())).toBe(expected);
  }, LONG);

  it('le flux au-dela de la limite recoit RST_STREAM REFUSED_STREAM, les autres sont acceptes', async () => {
    const { start, pc } = await lab();
    await start([HTTP_BLOCK('streams-per-connection 3;'), 'options { listen-on port 8080 tls none http h { any; }; recursion no; };'].join('\n'));
    const connection = rawHttp2(pc, 8080);
    connection.open(4);
    const resets = connection.frames().filter((frame) => frame.type === 'RST_STREAM');
    expect(resets.map((frame) => [frame.streamId, decodeRstStreamPayload(frame.payload)])).toEqual([[7, 7]]);
  }, LONG);

  it('la connexion au-dela de listener-clients n\'est servie que lorsqu\'une autre se ferme', async () => {
    const { start, pc } = await lab();
    await start([HTTP_BLOCK('listener-clients 2;'), 'options { listen-on port 8080 tls none http h { any; }; recursion no; };'].join('\n'));
    const first = rawHttp2(pc, 8080);
    const second = rawHttp2(pc, 8080);
    const third = rawHttp2(pc, 8080);
    expect([first, second, third].map((connection) => advertised(connection.frames()) !== undefined)).toEqual([true, true, false]);
    first.close();
    expect(advertised(third.frames())).toBe(100);
  }, LONG);

  it('listener-clients 0 ne limite rien', async () => {
    const { start, pc } = await lab();
    await start([HTTP_BLOCK('listener-clients 0;'), 'options { listen-on port 8080 tls none http h { any; }; recursion no; };'].join('\n'));
    const connections = Array.from({ length: 5 }, () => rawHttp2(pc, 8080));
    expect(connections.every((connection) => advertised(connection.frames()) !== undefined)).toBe(true);
  }, LONG);
});

describe('ALPN, h2 et h2c', () => {
  const CONFIG = [
    TLS('local-tls-b'),
    'options { listen-on port 853 tls local-tls { any; }; listen-on port 443 tls local-tls http default { any; }; listen-on port 80 tls none http default { any; }; recursion no; };',
  ].join('\n');

  it('un listener DoT sert un client qui n\'offre pas `dot`', async () => {
    const { start, pc, server } = await lab();
    await start(CONFIG);
    const anchor = pemToCert(vfsOf(server).readFile(`${PKI}/ca.pem`) ?? '')!;
    const query = buildLegacyQueryMessage(7, 'www.banquehorizon.com', 'A', {})!;
    const reply = await queryDnsOverTls(pc, new IPAddress(SERVER_IP), query, { anchors: [anchor], serverName: NAME, alpn: 'h2' });
    expect(reply?.answers.map((rr) => rr.data.type)).toEqual([1]);
  }, LONG);

  it('dig +https sur le DoH, +http-plain sur le 80 et leurs variantes GET', async () => {
    const { start, dig } = await lab();
    await start(CONFIG);
    expect(await dig('+https www.banquehorizon.com')).toContain(`;; SERVER: ${SERVER_IP}#443(${SERVER_IP}) (HTTPS)`);
    expect(await dig('+http-plain www.banquehorizon.com')).toContain(`;; SERVER: ${SERVER_IP}#80(${SERVER_IP}) (HTTP)`);
    expect(await dig('+http-plain-get www.banquehorizon.com')).toContain(`;; SERVER: ${SERVER_IP}#80(${SERVER_IP}) (HTTP-GET)`);
    expect(await dig('+http-plain-get www.banquehorizon.com +short')).toBe('203.0.113.20');
  }, LONG);

  it('+https vers un listener sans http : ALPN for HTTP/2 failed', async () => {
    const { start, dig } = await lab();
    await start(CONFIG);
    expect(await dig('-p 853 +https +tries=1 www.banquehorizon.com')).toBe(
      `;; Connection to ${SERVER_IP}#853(${SERVER_IP}) for www.banquehorizon.com failed: ALPN for HTTP/2 failed.\n;; no servers could be reached`);
  }, LONG);

  it('+https vers un port en clair : TLS error', async () => {
    const { start, dig } = await lab();
    await start(CONFIG);
    expect(await dig('-p 80 +https +tries=1 www.banquehorizon.com')).toBe(
      `;; Connection to ${SERVER_IP}#80(${SERVER_IP}) for www.banquehorizon.com failed: TLS error.\n;; no servers could be reached`);
  }, LONG);

  it('+http-plain vers un port TLS : end of file', async () => {
    const { start, dig } = await lab();
    await start(CONFIG);
    const out = await dig('-p 443 +http-plain +tries=1 www.banquehorizon.com');
    expect(out).toContain(`;; communications error to ${SERVER_IP}#443: end of file`);
    expect(out).toContain(';; no servers could be reached');
  }, LONG);

  it.each(['+tcp', '+tls', '+https', '+http-plain'])('%s vers un port ferme : connection refused, une paire de lignes par essai', async (option) => {
    const { start, dig } = await lab();
    await start(CONFIG);
    const pair = `;; Connection to ${SERVER_IP}#9999(${SERVER_IP}) for www.banquehorizon.com failed: connection refused.\n;; no servers could be reached`;
    expect(await dig(`-p 9999 ${option} +tries=2 www.banquehorizon.com`)).toBe(`${pair}\n${pair}`);
  }, LONG);

  it('un chemin inconnu en h2c est un echec de communication', async () => {
    const { start, dig } = await lab();
    await start(CONFIG);
    expect(await dig('+http-plain=/nope +tries=1 www.banquehorizon.com')).toContain(`;; communications error to ${SERVER_IP}#80: failure`);
  }, LONG);
});
