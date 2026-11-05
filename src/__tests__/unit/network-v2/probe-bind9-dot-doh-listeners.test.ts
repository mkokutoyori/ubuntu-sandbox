/**
 * Sonde — named ecoute en DNS sur TLS (RFC 7858) et en DNS sur HTTPS (RFC 8484), et `dig` les interroge.
 *
 * Mesure (BIND 9.18.39 et dig 9.18.39 reels, namespace de travail, certificats openssl) : `tls NOM { key-file; cert-file; }`,
 * `http NOM { endpoints { "/dns-query"; }; }` et `listen-on [port N] [tls NOM|ephemeral|none] [http NOM|default] { adresses; }`
 * font ecouter named en 853 et en 443 ; `dig +tls` seul ne verifie rien ; `+tls-ca=fichier` verifie la chaine et, comme nom, l'adresse
 * du serveur ; `+tls-hostname=nom` verifie ce nom ; un echec s'ecrit « ;; TLS peer certificate verification for ADRESSE#PORT failed:
 * RAISON » (« hostname mismatch », « unable to get local issuer certificate ») ; un fichier d'autorite illisible donne
 * « ;; TLS context cannot be created » ; `+https[=chemin]` / `+https-get` s'annoncent (HTTPS) / (HTTPS-GET) ; un chemin inconnu
 * donne « ;; communications error to ADRESSE#443: failure ». Les refus de named-checkconf et les erreurs de demarrage (fichier
 * absent, illisible, cle qui n'est pas celle du certificat) sont recopies de la meme mesure.
 *
 * Avant la correction (git stash push -- src/network) : 26 cas sur 28 tombent. named-checkconf refusait `tls`, `http` et
 * `listen-on ... tls`, donc named ne demarrait plus et rien ne repondait, pas meme sur le 53 en clair (le temoin de la configuration
 * complete tombe aussi). Passent avant et apres : la restriction de `listen-on` a une adresse que la machine n'a pas, et l'arret de
 * named, qui ferme les ecoutes ; ce sont deux refus, bornes par les cas d'ecoute reussie du meme fichier (853 et 443 dans `ss`).
 *
 * `self-signed certificate` (OpenSSL 3.0) : la table `x509VerifyErrors` disait `self signed certificate`, graphie d'OpenSSL 1.1 ;
 * openssl 3.0.13 reel et `OpenSslEngine` (autre chemin du simulateur) disent `self-signed certificate`. Deux tests figeaient l'ancienne
 * graphie (`openssl verify` dans openssl-prd-p0-p3 et openssl-verify-checks-signature) : ils sont corriges avec la table.
 */
import { describe, it, expect } from 'vitest';
import { IPAddress, SubnetMask, resetCounters } from '@/network/core/types';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { Cable } from '@/network/hardware/Cable';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import type { VirtualFileSystem } from '@/network/devices/linux/VirtualFileSystem';
import { queryDnsOverTls } from '@/network/dns/transport/DnsTlsTransport';
import { buildLegacyQueryMessage } from '@/network/dns/compat/DnsWireCompat';
import { pemToCert } from '@/network/pki/pem';

const SERVER_IP = '10.0.1.10';
const PC_IP = '10.0.1.2';
const PKI = '/etc/bind/tls';
const NAME = 'ns1.banquehorizon.com';

const ZONE = [
  '$TTL 3600',
  '@ IN SOA ns1 hostmaster ( 1 7200 900 1209600 3600 )',
  '@ IN NS ns1',
  'ns1 IN A 10.0.1.10',
  'www IN A 203.0.113.20', '',
].join('\n');

function vfsOf(machine: LinuxServer | LinuxPC): VirtualFileSystem {
  return (machine as unknown as { executor: { vfs: VirtualFileSystem } }).executor.vfs;
}

function writeRoot(machine: LinuxServer | LinuxPC, path: string, content: string): void {
  vfsOf(machine).writeFile(path, content, 0, 0, 0o022);
}

interface Lab {
  readonly server: LinuxServer;
  readonly pc: LinuxPC;
  start(config: string): Promise<string>;
  dig(arguments_: string): Promise<string>;
}

async function issueCertificate(server: LinuxServer, prefix: string, subjectName: string, issuer: string): Promise<void> {
  const sh = (command: string) => server.executeCommand(command);
  await sh(`openssl req -newkey rsa:2048 -nodes -keyout ${PKI}/${prefix}.key -out ${PKI}/${prefix}.csr -subj "/CN=${subjectName}"`);
  writeRoot(server, `${PKI}/${prefix}.ext`, `subjectAltName=DNS:${subjectName},IP:${SERVER_IP}\n`);
  await sh(`openssl x509 -req -in ${PKI}/${prefix}.csr -CA ${PKI}/${issuer}.pem -CAkey ${PKI}/${issuer}.key -CAcreateserial -out ${PKI}/${prefix}.pem -days 30 -extfile ${PKI}/${prefix}.ext`);
}

async function lab(): Promise<Lab> {
  resetCounters();
  resetDeviceCounters();
  Logger.clear();
  const server = new LinuxServer('linux-server', 'NS1');
  const pc = new LinuxPC('linux-pc', 'PC');
  const mask = new SubnetMask('255.255.255.0');
  new Cable('c1').connect(server.getPorts()[0], pc.getPorts()[0]);
  server.getPorts()[0].configureIP(new IPAddress(SERVER_IP), mask);
  pc.getPorts()[0].configureIP(new IPAddress(PC_IP), mask);

  await server.executeCommand(`mkdir -p ${PKI}`);
  for (const authority of ['ca', 'other']) {
    await server.executeCommand(`openssl req -x509 -newkey rsa:2048 -nodes -keyout ${PKI}/${authority}.key -out ${PKI}/${authority}.pem -days 30 -subj "/CN=${authority === 'ca' ? 'Test CA' : 'Other CA'}"`);
  }
  await issueCertificate(server, 'srv', NAME, 'ca');
  writeRoot(server, '/etc/bind/db.banquehorizon.com', ZONE);
  for (const authority of ['ca', 'other']) {
    writeRoot(pc, `/root/${authority}.pem`, vfsOf(server).readFile(`${PKI}/${authority}.pem`) ?? '');
  }

  return {
    server,
    pc,
    start: async (config) => {
      writeRoot(server, '/etc/bind/named.conf', [
        'tls local-tls { key-file "/etc/bind/tls/srv.key"; cert-file "/etc/bind/tls/srv.pem"; };',
        config,
        'zone "banquehorizon.com" { type primary; file "/etc/bind/db.banquehorizon.com"; };', '',
      ].join('\n'));
      return server.executeCommand('systemctl start named');
    },
    dig: (arguments_) => pc.executeCommand(`dig @${SERVER_IP} ${arguments_}`),
  };
}

const DOT_AND_DOH = 'options { listen-on tls local-tls { any; }; listen-on port 443 tls local-tls http default { any; }; recursion no; };';
const LONG = 120_000;

describe('named en DNS sur TLS et en DNS sur HTTPS', () => {
  it('temoin : le 53 en clair repond avec la meme configuration', async () => {
    const { start, dig } = await lab();
    await start(DOT_AND_DOH);
    expect(await dig('www.banquehorizon.com +short')).toBe('203.0.113.20');
  }, LONG);

  it('named ecoute en 853 et en 443 et le dit a ss', async () => {
    const { start, server } = await lab();
    await start(DOT_AND_DOH);
    const listening = await server.executeCommand('ss -ltnp');
    expect(listening).toMatch(/0\.0\.0\.0:853\s.*"named"/);
    expect(listening).toMatch(/0\.0\.0\.0:443\s.*"named"/);
  }, LONG);

  it('dig +tls sans option n\'authentifie rien et annonce (TLS) sur le 853', async () => {
    const { start, dig } = await lab();
    await start(DOT_AND_DOH);
    const out = await dig('+tls www.banquehorizon.com');
    expect(out).toContain('www.banquehorizon.com.\t3600\tIN\tA\t203.0.113.20');
    expect(out).toContain(`;; SERVER: ${SERVER_IP}#853(${SERVER_IP}) (TLS)`);
  }, LONG);

  it('+tls-ca verifie la chaine et accepte le certificat du serveur par son adresse', async () => {
    const { start, dig } = await lab();
    await start(DOT_AND_DOH);
    expect(await dig('+tls +tls-ca=/root/ca.pem www.banquehorizon.com +short')).toBe('203.0.113.20');
  }, LONG);

  it('+tls-hostname verifie le nom presente par le certificat', async () => {
    const { start, dig } = await lab();
    await start(DOT_AND_DOH);
    expect(await dig(`+tls +tls-ca=/root/ca.pem +tls-hostname=${NAME} www.banquehorizon.com +short`)).toBe('203.0.113.20');
    expect(await dig('+tls +tls-ca=/root/ca.pem +tls-hostname=other.example www.banquehorizon.com'))
      .toBe(`;; TLS peer certificate verification for ${SERVER_IP}#853 failed: hostname mismatch`);
  }, LONG);

  it('une autorite etrangere est refusee avec la raison d\'openssl', async () => {
    const { start, dig } = await lab();
    await start(DOT_AND_DOH);
    expect(await dig('+tls +tls-ca=/root/other.pem www.banquehorizon.com'))
      .toBe(`;; TLS peer certificate verification for ${SERVER_IP}#853 failed: unable to get local issuer certificate`);
  }, LONG);

  it('+tls-hostname seul authentifie avec les ancres du systeme, qui ne connaissent pas cette autorite', async () => {
    const { start, dig } = await lab();
    await start(DOT_AND_DOH);
    expect(await dig(`+tls +tls-hostname=${NAME} www.banquehorizon.com`))
      .toBe(`;; TLS peer certificate verification for ${SERVER_IP}#853 failed: unable to get local issuer certificate`);
  }, LONG);

  it('un fichier d\'autorite absent ou illisible donne « TLS context cannot be created »', async () => {
    const { start, dig } = await lab();
    await start(DOT_AND_DOH);
    expect(await dig('+tls +tls-ca=/root/absent.pem www.banquehorizon.com')).toBe(';; TLS context cannot be created');
  }, LONG);

  it('dig +https interroge le 443 et annonce (HTTPS), +https-get annonce (HTTPS-GET)', async () => {
    const { start, dig } = await lab();
    await start(DOT_AND_DOH);
    const post = await dig('+https www.banquehorizon.com');
    expect(post).toContain('www.banquehorizon.com.\t3600\tIN\tA\t203.0.113.20');
    expect(post).toContain(`;; SERVER: ${SERVER_IP}#443(${SERVER_IP}) (HTTPS)`);
    const get = await dig('+https-get www.banquehorizon.com');
    expect(get).toContain('203.0.113.20');
    expect(get).toContain(`;; SERVER: ${SERVER_IP}#443(${SERVER_IP}) (HTTPS-GET)`);
  }, LONG);

  it('un chemin que le serveur ne sert pas est un echec de communication', async () => {
    const { start, dig } = await lab();
    await start(DOT_AND_DOH);
    const out = await dig('+https=/nope +tries=1 www.banquehorizon.com');
    expect(out).toContain(`;; communications error to ${SERVER_IP}#443: failure`);
    expect(out).toContain(';; no servers could be reached');
  }, LONG);

  it('les memes verifications valent sous HTTPS', async () => {
    const { start, dig } = await lab();
    await start(DOT_AND_DOH);
    expect(await dig('+https +tls-ca=/root/ca.pem www.banquehorizon.com +short')).toBe('203.0.113.20');
    expect(await dig('+https +tls-ca=/root/other.pem www.banquehorizon.com'))
      .toBe(`;; TLS peer certificate verification for ${SERVER_IP}#443 failed: unable to get local issuer certificate`);
    expect(await dig('+https +tls-ca=/root/ca.pem +tls-hostname=other.example www.banquehorizon.com'))
      .toBe(`;; TLS peer certificate verification for ${SERVER_IP}#443 failed: hostname mismatch`);
  }, LONG);

  it('un chemin declare par un bloc http est servi, l\'autre non', async () => {
    const { start, dig } = await lab();
    await start([
      'http doh { endpoints { "/resolve"; }; };',
      'options { listen-on port 443 tls local-tls http doh { any; }; recursion no; };',
    ].join('\n'));
    expect(await dig('+https=/resolve www.banquehorizon.com +short')).toBe('203.0.113.20');
    expect(await dig('+https=/dns-query +tries=1 www.banquehorizon.com')).toContain(`communications error to ${SERVER_IP}#443: failure`);
  }, LONG);

  it('tls ephemeral : le serveur repond, mais aucune autorite ne le cautionne', async () => {
    const { start, dig } = await lab();
    await start('options { listen-on tls ephemeral { any; }; recursion no; };');
    expect(await dig('+tls www.banquehorizon.com +short')).toBe('203.0.113.20');
    expect(await dig('+tls +tls-ca=/root/ca.pem www.banquehorizon.com'))
      .toBe(`;; TLS peer certificate verification for ${SERVER_IP}#853 failed: self-signed certificate`);
  }, LONG);

  it('listen-on restreint aux adresses de la liste : une adresse que la machine n\'a pas n\'ecoute rien', async () => {
    const { start, dig, server } = await lab();
    await start('options { listen-on tls local-tls { 192.0.2.1; }; recursion no; };');
    expect(await server.executeCommand('ss -ltn')).not.toContain(':853');
    expect(await dig('+tls +tries=1 +time=1 www.banquehorizon.com +short')).toContain(';; no servers could be reached');
  }, LONG);

  it('le client DoT du systeme (queryDnsOverTls) refuse un nom que le certificat ne porte pas et dit pourquoi', async () => {
    const { start, pc, server } = await lab();
    await start(DOT_AND_DOH);
    const anchor = pemToCert(vfsOf(server).readFile(`${PKI}/ca.pem`) ?? '')!;
    const query = buildLegacyQueryMessage(7, 'www.banquehorizon.com', 'A', {})!;
    const reasons: string[] = [];
    const wrong = await queryDnsOverTls(pc, new IPAddress(SERVER_IP), query, {
      anchors: [anchor], serverName: 'other.example', onVerifyFailure: (text) => reasons.push(text),
    });
    expect(wrong).toBeNull();
    expect(reasons).toEqual(['hostname mismatch']);
    const right = await queryDnsOverTls(pc, new IPAddress(SERVER_IP), query, { anchors: [anchor], serverName: NAME });
    expect(right?.answers).toHaveLength(1);
  }, LONG);

  it('arreter named ferme les ecoutes chiffrees', async () => {
    const { start, server } = await lab();
    await start(DOT_AND_DOH);
    await server.executeCommand('systemctl stop named');
    const listening = await server.executeCommand('ss -ltn');
    expect(listening).not.toContain(':853');
    expect(listening).not.toContain(':443');
  }, LONG);
});

describe('named-checkconf et demarrage', () => {
  const check = async (config: string): Promise<string> => {
    const { server } = await lab();
    writeRoot(server, '/etc/bind/named.conf', `${config}\n`);
    return server.executeCommand('named-checkconf');
  };

  it('temoin : la configuration complete est acceptee sans un mot', async () => {
    const { server } = await lab();
    writeRoot(server, '/etc/bind/named.conf', [
      'tls local-tls { key-file "/etc/bind/tls/srv.key"; cert-file "/etc/bind/tls/srv.pem"; protocols { TLSv1.3; }; };',
      'http doh { endpoints { "/dns-query"; "/other"; }; };',
      DOT_AND_DOH, '',
    ].join('\n'));
    expect(await server.executeCommand('named-checkconf')).toBe('');
  }, LONG);

  it.each([
    ['un nom tls inconnu', 'options { listen-on tls nosuch { any; }; };', "tls 'nosuch' is not defined"],
    ['un nom http inconnu', 'tls x { key-file "/k"; cert-file "/c"; };\noptions { listen-on port 443 tls x http nosuch { any; }; };', "http 'nosuch' is not defined"],
    ['http sans tls', 'options { listen-on port 80 http default { any; }; };', "http must specify a 'tls' statement, 'tls ephemeral', or 'tls none'"],
    ['un tls qui n\'a qu\'un fichier', 'tls x { key-file "/k"; };', "tls 'x': 'cert-file' and 'key-file' must both be specified, or both omitted"],
    ['un nom tls reserve', 'tls ephemeral { key-file "/k"; cert-file "/c"; };', "tls clause name 'ephemeral' is reserved for internal use"],
    ['un tls declare deux fois', 'tls x { key-file "/k"; cert-file "/c"; };\ntls x { key-file "/k"; cert-file "/c"; };', "tls clause 'x' is duplicated: also defined at /etc/bind/named.conf:1"],
    ['une option tls inconnue', 'tls x { key-file "/k"; cert-file "/c"; foo bar; };', "unknown option 'foo'"],
    ['un protocole inconnu', 'tls x { key-file "/k"; cert-file "/c"; protocols { SSLv3; }; };', "'SSLv3' is not a valid TLS protocol version"],
    ['un point d\'acces relatif', 'http h { endpoints { "dns-query"; }; };', "endpoint 'dns-query' is not a valid absolute HTTP path"],
  ])('refuse %s', async (_name, config, message) => {
    expect(await check(config)).toContain(message);
  }, LONG);

  it('un fichier de certificat absent empeche named de demarrer et le journal dit pourquoi', async () => {
    const { server } = await lab();
    writeRoot(server, '/etc/bind/named.conf', [
      'tls broken { key-file "/etc/bind/tls/srv.key"; cert-file "/etc/bind/tls/absent.pem"; };',
      'options { listen-on tls broken { any; }; recursion no; };', '',
    ].join('\n'));
    await server.executeCommand('systemctl start named');
    expect(await server.executeCommand('systemctl is-active named')).toBe('failed');
    const journal = await server.executeCommand('cat /var/log/syslog');
    expect(journal).toContain("SSL_CTX_use_certificate_chain_file: '/etc/bind/tls/absent.pem' failed: error:0A080002:SSL routines::system lib");
    expect(journal).toContain('Error initializing TLS context: error:80000002:system library::No such file or directory');
  }, LONG);

  it('une cle qui n\'est pas celle du certificat empeche named de demarrer', async () => {
    const { server } = await lab();
    writeRoot(server, '/etc/bind/named.conf', [
      'tls mismatch { key-file "/etc/bind/tls/other.key"; cert-file "/etc/bind/tls/srv.pem"; };',
      'options { listen-on tls mismatch { any; }; recursion no; };', '',
    ].join('\n'));
    await server.executeCommand('systemctl start named');
    expect(await server.executeCommand('systemctl is-active named')).toBe('failed');
    expect(await server.executeCommand('cat /var/log/syslog'))
      .toContain("SSL_CTX_use_PrivateKey_file: '/etc/bind/tls/other.key' failed: error:05800074:x509 certificate routines::key values mismatch");
  }, LONG);
});
