/**
 * Sonde — `also-notify` : le port, la cle TSIG, `tls`, le niveau `options`, une cible par adresse et par port.
 *
 * Mesure (BIND 9.18.39 reel, deux instances sur 127.0.0.1 et 127.0.0.2, `tcpdump -i lo`, un secondaire reel, un NOTIFY signe fabrique a la main) :
 *   - `also-notify { ADRESSE [port N] [key K] [tls T]; }` : le NOTIFY part en UDP clair (81 octets : l'en-tete, la question SOA, le SOA en reponse)
 *     vers le port de l'entree ; `also-notify port N { ... }` donne le port par defaut des entrees qui n'en ont pas, l'entree gagne ;
 *     sans port, 53 ; avec `tls T` et sans port, 853 (toujours en UDP clair : named ne chiffre pas le NOTIFY) ;
 *   - `key K` signe le NOTIFY en TSIG (156 octets) ; une cle que le fichier ne definit pas laisse le NOTIFY non signe (81 octets) ;
 *   - `also-notify` existe aussi dans `options` ; celui d'une zone le REMPLACE (il ne s'y ajoute pas), et `also-notify { }` dans la zone
 *     n'envoie rien ; deux entrees de meme adresse et de meme port ne font qu'un NOTIFY, et avec `notify yes` un serveur de noms de la zone et
 *     une entree de meme adresse mais de port different sont deux cibles distinctes ; named envoie aussi ses NOTIFY au demarrage, des
 *     que la zone primaire est chargee ;
 *   - un secondaire qui connait la cle journalise `ADRESSE#PORT/key K: received notify for zone 'Z': TSIG 'K'` et repond signe (105 octets) ;
 *     un secondaire sans la cle, ou avec un autre secret, ou une horloge ecartee de plus du fudge, journalise
 *     `ADRESSE#PORT: request has invalid signature: TSIG K: tsig verify failure (BADKEY | BADSIG | BADTIME)` et repond NOTAUTH ;
 *     un NOTIFY non signe journalise `received notify for zone 'Z'` ;
 *   - named-checkconf : un mot inconnu apres l'adresse donne « missing ';' before 'MOT' » (primaries aussi : l'ancien « unexpected 'MOT' » n'est pas celui
 *     de named), `key` sans nom « expected string near ';' », `tls` inconnu « tls 'T' is not defined », un port hors bornes « port number out of range near 'N' »,
 *     un port d'instruction illisible « expected number near 'X' », `dscp` avant `port` « '{' expected near 'port' » ; une cle non definie est acceptee ;
 *   - `primaries port N { ... }` : le port de l'instruction est le defaut des entrees, comme pour `also-notify`.
 *   Non mesure : `dscp` (accepte, non applique : le simulateur n'a pas de DSCP sur ses datagrammes DNS), les adresses IPv6 (named les accepte, le simulateur
 *   refuse encore « expected IP address »), les listes nommees (`also-notify { liste; }`).
 *
 * Avant la correction (git stash push -- src/network) : 24 cas sur 25 tombent (le port, la cle, `tls`, le niveau `options` et les messages de grammaire
 * n'etaient pas lus, named ne notifiait pas au demarrage, le secondaire ne verifiait pas la signature et ne journalisait rien). Passe des deux cotes :
 * `also-notify { }` dans la zone (aucune cible, donc rien ne part ; le cas est borne par les cas voisins du meme laboratoire, qui recoivent leur NOTIFY).
  */
import { describe, it, expect } from 'vitest';
import { decodeDnsMessage } from '@/network/dns/wire/DnsMessageCodec';
import { RRType } from '@/network/dns/wire/RRType';
import { DnsOpcode } from '@/network/dns/wire/DnsHeaderFlags';
import { lab, writeRoot, SERVER_IP, PC_IP } from './_bind9-tls-lab';

const LONG = 180_000;
const KEY = 'key k1 { algorithm hmac-sha256; secret "c2VjcmV0c2VjcmV0c2VjcmV0c2VjcmV0"; };';
const OTHER_KEY = 'key k1 { algorithm hmac-sha256; secret "ZGlmZmVyZW50c2VjcmV0ZGlmZmVyZW50c2U="; };';
const ZONE = 'zone "banquehorizon.com" { type primary; file "/etc/bind/db.banquehorizon.com"; allow-transfer { any; };';

interface Received { readonly port: number; readonly signed: boolean; readonly notify: boolean; readonly bytes: number }

async function settle(): Promise<void> {
  for (let tour = 0; tour < 30; tour++) await new Promise((resolve) => setTimeout(resolve, 5));
}

async function notifying(ports: readonly number[], zoneOptions: string, options = '', top = ''): Promise<Received[]> {
  const { server, pc } = await lab('server');
  const received: Received[] = [];
  for (const port of ports) {
    const bound = (pc as unknown as { udpBind: (p: number, l: (d: { udp: { payload: unknown } }) => void, n: string) => number | false }).udpBind(port, ({ udp }) => {
      if (!(udp.payload instanceof Uint8Array)) return;
      const message = decodeDnsMessage(udp.payload);
      received.push({
        port, bytes: udp.payload.length, notify: message.flags.opcode === DnsOpcode.NOTIFY,
        signed: message.additionals.some((record) => record.data.type === RRType.TSIG),
      });
    }, 'probe');
    expect(bound).toBe(port);
  }
  writeRoot(server, '/etc/bind/named.conf', [
    top, `options { recursion no; notify explicit; ${options} };`, `${ZONE} ${zoneOptions} };`, '',
  ].join('\n'));
  await server.executeCommand('systemctl start named');
  await settle();
  return received;
}

describe('also-notify : le port', () => {
  it('le port de l\'entree est celui du NOTIFY', async () => {
    const received = await notifying([8530], `also-notify { ${PC_IP} port 8530; };`);
    expect(received.map((r) => [r.port, r.notify, r.signed])).toEqual([[8530, true, false]]);
  }, LONG);

  it('le port de l\'instruction est le defaut des entrees, l\'entree gagne', async () => {
    const received = await notifying([8531, 8532], `also-notify port 8531 { ${PC_IP} port 8532; ${PC_IP}; };`);
    expect(received.map((r) => r.port).sort()).toEqual([8531, 8532]);
  }, LONG);

  it('tls sans port donne le 853, en UDP clair', async () => {
    const received = await notifying([853], `also-notify { ${PC_IP} tls t; };`, '', 'tls t { };');
    expect(received.map((r) => [r.port, r.notify, r.signed])).toEqual([[853, true, false]]);
  }, LONG);

  it('la meme adresse et le meme port ne font qu\'une cible', async () => {
    const received = await notifying([8533], `also-notify { ${PC_IP} port 8533; ${PC_IP} port 8533; };`);
    expect(received).toHaveLength(1);
  }, LONG);
});

describe('also-notify : la cle TSIG', () => {
  it('key signe le NOTIFY', async () => {
    const received = await notifying([8530], `also-notify { ${PC_IP} port 8530 key k1; };`, '', KEY);
    expect(received.map((r) => [r.notify, r.signed])).toEqual([[true, true]]);
    expect(received[0].bytes).toBeGreaterThan(120);
  }, LONG);

  it('une cle que le fichier ne definit pas laisse le NOTIFY non signe', async () => {
    const received = await notifying([8530], `also-notify { ${PC_IP} port 8530 key nokey; };`, '', KEY);
    expect(received.map((r) => [r.notify, r.signed])).toEqual([[true, false]]);
  }, LONG);
});

describe('also-notify : le niveau options', () => {
  it('celui d\'options vaut pour une zone qui n\'en declare pas', async () => {
    const received = await notifying([8540], '', `also-notify { ${PC_IP} port 8540; };`);
    expect(received.map((r) => r.port)).toEqual([8540]);
  }, LONG);

  it('celui de la zone remplace celui d\'options', async () => {
    const received = await notifying([8540, 8541], `also-notify { ${PC_IP} port 8541; };`, `also-notify { ${PC_IP} port 8540; };`);
    expect(received.map((r) => r.port)).toEqual([8541]);
  }, LONG);

  it('une liste vide dans la zone n\'envoie rien', async () => {
    const received = await notifying([8540], 'also-notify { };', `also-notify { ${PC_IP} port 8540; };`);
    expect(received).toEqual([]);
  }, LONG);
});

describe('also-notify : le secondaire', () => {
  async function pair(secondaryKey: string, notifyKey: string) {
    const { server, pc } = await lab('server');
    writeRoot(pc, '/etc/bind/named.conf', [
      secondaryKey, 'options { recursion no; };',
      `zone "banquehorizon.com" { type secondary; file "/var/cache/bind/db.banquehorizon.com"; primaries { ${SERVER_IP}; }; };`, '',
    ].join('\n'));
    await pc.executeCommand('mkdir -p /var/cache/bind');
    await pc.executeCommand('systemctl start named');
    writeRoot(server, '/etc/bind/named.conf', [
      KEY, 'options { recursion no; notify explicit; };',
      `${ZONE} also-notify { ${PC_IP} ${notifyKey}; }; };`, '',
    ].join('\n'));
    await server.executeCommand('systemctl start named');
    await settle();
    return pc.executeCommand('cat /var/log/syslog');
  }

  it('temoin : un NOTIFY non signe est journalise', async () => {
    expect(await pair('', '')).toContain(`client @0x0 ${SERVER_IP}#`);
  }, LONG);

  it('une cle commune : le NOTIFY est journalise avec la cle', async () => {
    const journal = await pair(KEY, 'key k1');
    expect(journal).toMatch(new RegExp(`${SERVER_IP}#\\d+/key k1: received notify for zone 'banquehorizon.com': TSIG 'k1'`));
  }, LONG);

  it('un secondaire sans la cle refuse avec BADKEY', async () => {
    const journal = await pair('', 'key k1');
    expect(journal).toContain('request has invalid signature: TSIG k1: tsig verify failure (BADKEY)');
    expect(journal).not.toContain('received notify');
  }, LONG);

  it('un autre secret refuse avec BADSIG', async () => {
    const journal = await pair(OTHER_KEY, 'key k1');
    expect(journal).toContain('request has invalid signature: TSIG k1: tsig verify failure (BADSIG)');
  }, LONG);
});

describe('primaries port : le port de l\'instruction', () => {
  it('le secondaire interroge le port de l\'instruction', async () => {
    const { server, pc } = await lab('server');
    writeRoot(server, '/etc/bind/named.conf', [
      'options { listen-on port 5300 { any; }; recursion no; };', `${ZONE} };`, '',
    ].join('\n'));
    await server.executeCommand('systemctl start named');
    writeRoot(pc, '/etc/bind/named.conf', [
      'options { recursion no; };',
      `zone "banquehorizon.com" { type secondary; file "/var/cache/bind/db.banquehorizon.com"; primaries port 5300 { ${SERVER_IP}; }; };`, '',
    ].join('\n'));
    await pc.executeCommand('mkdir -p /var/cache/bind');
    await pc.executeCommand('systemctl start named');
    await settle();
    expect(await pc.executeCommand('dig @127.0.0.1 www.banquehorizon.com +short')).toBe('203.0.113.20');
  }, LONG);
});

describe('also-notify : grammaire', () => {
  const check = async (config: string): Promise<string> => {
    const { server } = await lab();
    writeRoot(server, '/etc/bind/named.conf', `${config}\n`);
    return server.executeCommand('named-checkconf');
  };
  const zone = (entry: string) => `tls t { }; key k { algorithm hmac-sha256; secret "aGVsbG8="; };\nzone "x" { type primary; file "/etc/bind/db.banquehorizon.com"; ${entry} };`;

  it('temoin : la grammaire complete est acceptee, une cle non definie aussi', async () => {
    expect(await check(zone('also-notify port 53 dscp 5 { 10.0.0.1 port 53 key k tls t; 10.0.0.2 key nokey; 10.0.0.3; };'))).toBe('');
    expect(await check(`options { also-notify { 10.0.0.1 port 53; }; };\n${zone('')}`)).toBe('');
  }, LONG);

  it.each([
    ['un mot inconnu', zone('also-notify { 10.0.0.1 foo; };'), "/etc/bind/named.conf:2: missing ';' before 'foo'"],
    ['tls avant key', zone('also-notify { 10.0.0.1 tls t key k; };'), "/etc/bind/named.conf:2: missing ';' before 'key'"],
    ['key sans nom', zone('also-notify { 10.0.0.1 key; };'), "/etc/bind/named.conf:2: expected string near ';'"],
    ['un tls inconnu', zone('also-notify { 10.0.0.1 tls nope; };'), "/etc/bind/named.conf:2: tls 'nope' is not defined"],
    ['un port hors bornes', zone('also-notify { 10.0.0.1 port 70000; };'), "/etc/bind/named.conf:2: port number out of range near '70000'"],
    ['un port illisible', zone('also-notify { 10.0.0.1 port x; };'), "/etc/bind/named.conf:2: expected port number or '*' near 'x'"],
    ['un port d\'instruction illisible', zone('also-notify port x { 10.0.0.1; };'), "/etc/bind/named.conf:2: expected number near 'x'"],
    ['dscp avant port', zone('also-notify dscp 5 port 8 { 10.0.0.1; };'), "/etc/bind/named.conf:2: '{' expected near 'port'"],
    ['un mot inconnu au niveau options', `options { also-notify { 10.0.0.1 foo; }; };`, "/etc/bind/named.conf:1: missing ';' before 'foo'"],
    ['un mot inconnu apres une adresse de primaries', zone('').replace('type primary', 'type secondary').replace(' file "/etc/bind/db.banquehorizon.com";', ' primaries { 10.0.0.1 foo; };'), "/etc/bind/named.conf:2: missing ';' before 'foo'"],
  ])('refuse %s', async (_name, config, message) => {
    expect(await check(config)).toBe(message);
  }, LONG);
});
