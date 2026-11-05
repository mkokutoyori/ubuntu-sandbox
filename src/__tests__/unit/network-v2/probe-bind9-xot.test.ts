/**
 * Sonde — transfert de zone par TLS (XoT, RFC 9103) et certificat client de dig.
 *
 * Mesure (deux BIND 9.18.39 reels sur 127.0.0.1 et 127.0.0.2, dig 9.18.39, openssl 3.0.13) :
 *   - `primaries { ADRESSE [port N] [key CLE] [tls NOM]; }` : l'ordre est fixe ; `tls inconnu` donne « tls 'NOM' is not defined »
 *     a la ligne de l'entree, `tls ephemeral` est accepte, `tls none` ne l'est pas ; `port abc` donne « expected port number or '*' near 'abc' »,
 *     `port 99999` « port number out of range near '99999' » ;
 *   - avec `tls`, le secondaire interroge ET transfere en TLS : un primaire dont le 53 en clair est ferme (`listen-on { none; }`) et qui
 *     n'ecoute qu'en TLS lui donne quand meme la zone ; le port par defaut est 853 ;
 *   - sans `ca-file` ni `remote-hostname`, le TLS est opportuniste : aucune verification, le transfert reussit ;
 *   - `ca-file` seul : la chaine est verifiee et le nom attendu est l'adresse du primaire (le certificat porte `IP:127.0.0.1`) ;
 *   - `ca-file` + `remote-hostname` : ce nom est verifie ; un nom que le certificat ne porte pas fait echouer le transfert avec
 *     « failed to connect: TLS peer certificate verification failed » puis « Transfer status: TLS peer certificate verification failed » ;
 *   - `remote-hostname` seul : verification avec les ancres du systeme, qui ne connaissent pas l'autorite : meme echec ;
 *   - un `ca-file` inutilisable donne « Transfer status: failure » puis « zone transfer setup failed » ;
 *   - un serveur DoT sert l'AXFR (`dig +tls AXFR` rend la zone) ;
 *   - dig : `+tls-ca`, `+tls-hostname`, `+tls-certfile` et `+tls-keyfile` allument `+tls` d'eux-memes (un 53 en UDP n'est plus interroge) ;
 *     cle ou certificat seul donne « ;; both TLS client certificate and key file must be specified a the same time » (graphie du
 *     programme) meme sans `+tls` ; un fichier absent, illisible ou une cle qui n'est pas celle du certificat donne « ;; TLS context cannot
 *     be created » ; un certificat client force la verification du serveur (sans `+tls-ca`, « unable to get local issuer certificate ») ; un
 *     listener avec `ca-file` ferme la connexion d'un client sans certificat ou avec un certificat d'une autre autorite
 *     (« communications error to ...: end of file ») et sert celui qui est signe par son autorite.
 *   Non rejoue : le journal horodate que dig ecrit sur stderr avant « TLS context cannot be created » ; les lignes « Transfer started » et
 *   « Transfer completed » de named, qui portent des durees.
 *
 * Avant la correction (git stash push -- src/network src/powershell) : 22 cas sur 26 tombent. Passent des deux cotes : le transfert en
 * clair du meme laboratoire (le laboratoire est sain), `dig +tls AXFR` (le serveur DoT servait deja l'AXFR), `remote-hostname` seul (un
 * refus, borne par le cas voisin ou ca-file et remote-hostname justes font aboutir le transfert) et le certificat signe par l'autorite
 * du listener (servi dans les deux cas : l'UDP du meme laboratoire repond).
 */
import { describe, it, expect } from 'vitest';
import { lab, vfsOf, writeRoot, SERVER_IP, PKI, NAME, issueCertificate } from './_bind9-tls-lab';

const LONG = 180_000;
const TLS_SERVER = `tls srv { key-file "${PKI}/srv.key"; cert-file "${PKI}/srv.pem"; };`;
const SECONDARY_ZONE = (primaries: string) =>
  `zone "banquehorizon.com" { type secondary; file "/var/cache/bind/db.banquehorizon.com"; primaries { ${primaries}; }; };`;

async function settle(): Promise<void> {
  for (let tour = 0; tour < 20; tour++) await new Promise((resolve) => setTimeout(resolve, 5));
}

async function secondaryLab(tlsBlock: string, primaryEntry: string, primaryListen = 'listen-on { none; }; listen-on port 853 tls srv { any; };') {
  const context = await lab('server');
  const { server: primary, pc: secondary } = context;
  writeRoot(primary, '/etc/bind/named.conf', [
    TLS_SERVER, `options { ${primaryListen} recursion no; };`,
    'zone "banquehorizon.com" { type primary; file "/etc/bind/db.banquehorizon.com"; allow-transfer { any; }; };', '',
  ].join('\n'));
  await primary.executeCommand('systemctl start named');
  writeRoot(secondary, '/etc/bind/tls/ca.pem', vfsOf(primary).readFile(`${PKI}/ca.pem`) ?? '');
  writeRoot(secondary, '/etc/bind/named.conf', [
    tlsBlock, 'options { recursion no; };', SECONDARY_ZONE(primaryEntry), '',
  ].join('\n'));
  await secondary.executeCommand('mkdir -p /var/cache/bind');
  await secondary.executeCommand('systemctl start named');
  await settle();
  return { ...context, primary, secondary, answer: () => secondary.executeCommand('dig @127.0.0.1 www.banquehorizon.com +short') };
}

describe('primaries ... tls : grammaire', () => {
  const check = async (config: string): Promise<string> => {
    const { server } = await lab();
    writeRoot(server, '/etc/bind/named.conf', `${config}\n`);
    return server.executeCommand('named-checkconf');
  };

  it('temoin : port, key et tls dans l\'ordre sont acceptes', async () => {
    expect(await check([
      'tls t { ca-file "/x"; };', 'key k { algorithm hmac-sha256; secret "aGVsbG8="; };',
      'zone "x" { type secondary; primaries { 10.0.0.1 port 853 key k tls t; 10.0.0.2 tls ephemeral; 10.0.0.3; }; };',
    ].join('\n'))).toBe('');
  }, LONG);

  it.each([
    ['un tls inconnu', 'zone "x" {\n  type secondary;\n  primaries {\n    10.0.0.1 tls nosuch;\n  };\n};', "/etc/bind/named.conf:4: tls 'nosuch' is not defined"],
    ['tls none', 'zone "x" { type secondary; primaries { 10.0.0.1 tls none; }; };', "/etc/bind/named.conf:1: tls 'none' is not defined"],
    ['un port illisible', 'zone "x" { type secondary; primaries { 10.0.0.1 port abc; }; };', "/etc/bind/named.conf:1: expected port number or '*' near 'abc'"],
    ['un port hors bornes', 'zone "x" { type secondary; primaries { 10.0.0.1 port 99999; }; };', "/etc/bind/named.conf:1: port number out of range near '99999'"],
  ])('refuse %s', async (_name, config, message) => {
    expect(await check(config)).toBe(message);
  }, LONG);
});

describe('XoT : le secondaire transfere en TLS', () => {
  it('temoin : en clair, sur le meme laboratoire, la zone est transferee', async () => {
    const { answer } = await secondaryLab('', `${SERVER_IP}`, 'listen-on { any; };');
    expect(await answer()).toBe('203.0.113.20');
  }, LONG);

  it('un primaire qui n\'ecoute qu\'en TLS donne la zone a un secondaire qui verifie chaine et nom', async () => {
    const { answer } = await secondaryLab(
      `tls ts { ca-file "/etc/bind/tls/ca.pem"; remote-hostname "${NAME}"; };`, `${SERVER_IP} tls ts`);
    expect(await answer()).toBe('203.0.113.20');
  }, LONG);

  it('sans ca-file ni remote-hostname, le TLS est opportuniste', async () => {
    const { answer } = await secondaryLab('tls ts { };', `${SERVER_IP} tls ts`);
    expect(await answer()).toBe('203.0.113.20');
  }, LONG);

  it('ca-file seul verifie le nom contre l\'adresse du primaire', async () => {
    const { answer } = await secondaryLab('tls ts { ca-file "/etc/bind/tls/ca.pem"; };', `${SERVER_IP} tls ts`);
    expect(await answer()).toBe('203.0.113.20');
  }, LONG);

  it('un port explicite remplace le 853', async () => {
    const { answer } = await secondaryLab(
      'tls ts { };', `${SERVER_IP} port 8853 tls ts`, 'listen-on { none; }; listen-on port 8853 tls srv { any; };');
    expect(await answer()).toBe('203.0.113.20');
  }, LONG);

  it('un nom que le certificat ne porte pas fait echouer le transfert et le journal dit pourquoi', async () => {
    const { answer, secondary } = await secondaryLab(
      'tls ts { ca-file "/etc/bind/tls/ca.pem"; remote-hostname "wrong.example"; };', `${SERVER_IP} tls ts`);
    expect(await answer()).not.toBe('203.0.113.20');
    const journal = await secondary.executeCommand('cat /var/log/syslog');
    expect(journal).toContain(`transfer of 'banquehorizon.com/IN' from ${SERVER_IP}#853: failed to connect: TLS peer certificate verification failed`);
    expect(journal).toContain(`transfer of 'banquehorizon.com/IN' from ${SERVER_IP}#853: Transfer status: TLS peer certificate verification failed`);
  }, LONG);

  it('remote-hostname seul verifie avec les ancres du systeme : l\'autorite d\'essai y manque, le transfert echoue', async () => {
    const { answer } = await secondaryLab(`tls ts { remote-hostname "${NAME}"; };`, `${SERVER_IP} tls ts`);
    expect(await answer()).not.toBe('203.0.113.20');
  }, LONG);

  it('un ca-file inutilisable fait echouer l\'installation du transfert', async () => {
    const { answer, secondary } = await secondaryLab('tls ts { ca-file "/etc/bind/named.conf"; };', `${SERVER_IP} tls ts`);
    expect(await answer()).not.toBe('203.0.113.20');
    expect(await secondary.executeCommand('cat /var/log/syslog')).toContain(`from ${SERVER_IP}#853: zone transfer setup failed`);
  }, LONG);

  it('dig +tls AXFR lit la zone sur le 853', async () => {
    const { primary, secondary } = await secondaryLab('tls ts { };', `${SERVER_IP} tls ts`);
    expect(primary).toBeDefined();
    const out = await secondary.executeCommand(`dig @${SERVER_IP} +tls AXFR banquehorizon.com`);
    expect(out).toContain('www.banquehorizon.com.\t3600\tIN\tA\t203.0.113.20');
    expect(out).toContain(`;; SERVER: ${SERVER_IP}#853(${SERVER_IP}) (TLS)`);
  }, LONG);
});

describe('dig : certificat client', () => {
  const mutualLab = async () => {
    const context = await lab();
    const { server, pc, start } = context;
    await issueCertificate(server, 'cli', 'client1', 'ca');
    await issueCertificate(server, 'rogue', 'rogue', 'other');
    for (const file of ['cli.pem', 'cli.key', 'rogue.pem', 'rogue.key']) {
      writeRoot(pc, `/root/${file}`, vfsOf(server).readFile(`${PKI}/${file}`) ?? '');
    }
    writeRoot(pc, '/root/garbage.pem', 'not a pem\n');
    await start([
      `tls mutual { key-file "${PKI}/srv.key"; cert-file "${PKI}/srv.pem"; ca-file "${PKI}/ca.pem"; };`,
      'options { listen-on port 853 tls mutual { any; }; recursion no; };',
    ].join('\n'));
    return context;
  };
  const CA = '+tls-ca=/root/ca.pem';
  const IDENTITY = '+tls-certfile=/root/cli.pem +tls-keyfile=/root/cli.key';

  it('un client sans certificat est ferme par un listener qui a un ca-file', async () => {
    const { dig } = await mutualLab();
    const out = await dig(`+tls ${CA} +tries=1 www.banquehorizon.com`);
    expect(out).toContain(`;; communications error to ${SERVER_IP}#853: end of file`);
    expect(out).toContain(';; no servers could be reached');
  }, LONG);

  it('un certificat signe par l\'autorite du listener est servi', async () => {
    const { dig } = await mutualLab();
    expect(await dig(`${CA} ${IDENTITY} www.banquehorizon.com +short`)).toBe('203.0.113.20');
  }, LONG);

  it('un certificat d\'une autre autorite est ferme', async () => {
    const { dig } = await mutualLab();
    const out = await dig(`${CA} +tls-certfile=/root/rogue.pem +tls-keyfile=/root/rogue.key +tries=1 www.banquehorizon.com`);
    expect(out).toContain('end of file');
  }, LONG);

  it('un certificat client sans +tls-ca authentifie le serveur avec les ancres du systeme', async () => {
    const { dig } = await mutualLab();
    expect(await dig(`${IDENTITY} www.banquehorizon.com`))
      .toBe(`;; TLS peer certificate verification for ${SERVER_IP}#853 failed: self-signed certificate in certificate chain`);
  }, LONG);

  it.each(['+tls-ca=/root/ca.pem', '+tls-hostname=x.y', '+tls-certfile=/root/cli.pem +tls-keyfile=/root/cli.key'])(
    '%s allume +tls', async (option) => {
      const { dig } = await mutualLab();
      expect(await dig(`${option} -p 9999 +tries=1 www.banquehorizon.com`))
        .toBe(`;; Connection to ${SERVER_IP}#9999(${SERVER_IP}) for www.banquehorizon.com failed: connection refused.\n;; no servers could be reached`);
    }, LONG);

  it.each(['+tls-certfile=/root/cli.pem', '+tls-keyfile=/root/cli.key'])(
    '%s seul : les deux fichiers sont exiges, meme sans +tls', async (option) => {
      const { dig } = await mutualLab();
      expect(await dig(`${option} www.banquehorizon.com`))
        .toBe(';; both TLS client certificate and key file must be specified a the same time');
    }, LONG);

  it.each([
    ['un certificat absent', '+tls-certfile=/root/none.pem +tls-keyfile=/root/cli.key'],
    ['une cle illisible', '+tls-certfile=/root/cli.pem +tls-keyfile=/root/garbage.pem'],
    ['une cle qui n\'est pas celle du certificat', '+tls-certfile=/root/cli.pem +tls-keyfile=/root/rogue.key'],
  ])('%s : TLS context cannot be created', async (_name, option) => {
    const { dig } = await mutualLab();
    expect(await dig(`${CA} ${option} www.banquehorizon.com`)).toBe(';; TLS context cannot be created');
  }, LONG);
});
