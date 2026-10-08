/**
 * Apache httpd 2.4.58 (modules/ssl/ssl_util_stapling.c, ssl_util_ocsp.c, ssl_engine_ocsp.c) : quand le répondeur ne répond pas, `stapling_renew_response`
 * fabrique une réponse `tryLater` si SSLStaplingFakeTryLater est actif (défaut on), la met en cache pour SSLStaplingErrorCacheTimeout (défaut 600 s),
 * et `stapling_cb` ne l'agrafe que si SSLStaplingReturnResponderErrors est actif (défaut on). SSLStaplingResponderTimeout et SSLOCSPResponderTimeout
 * bornent la connexion puis l'attente de la réponse (socket APR) ; SSLOCSPProxyURL fait passer la requête par le proxy, en POST d'URL absolue.
 *
 * MESURÉ avant correctif : ces directives étaient lues et mémorisées sans effet ; un répondeur muet laissait le serveur sans agrafe, là où Apache
 * agrafe un tryLater, et un délai de 3 s sur la liaison n'était jamais comparé à la borne de 2 s. Avant correctif (git stash de src/network) 6 cas
 * sur 9 tombent (tryLater par défaut, cache d'erreur, délai d'agrafage, proxy comme prochain saut, proxy injoignable, délai du certificat client) ; trois passent dans les deux états :
 * le témoin (répondeur sain, agrafe « good »), et les deux cas où l'absence d'agrafe est le comportement voulu (FakeTryLater off, ReturnResponderErrors off),
 * que le code d'avant donnait déjà faute de savoir fabriquer un tryLater.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import { Cable } from '@/network/hardware/Cable';
import { IPAddress, SubnetMask } from '@/network/core/types';
import { PathClock } from '@/network/core/time/PathClock';

beforeEach(() => { EquipmentRegistry.getInstance().clear(); PathClock.reset(); });

const CA = '/etc/ssl/CA';
const MASK = new SubnetMask('255.255.255.0');

const sh = (srv: LinuxServer, command: string): Promise<string> => srv.executeCommand(command);

async function lab(name: string, options: { responderUp: boolean } = { responderUp: true }) {
  const web = new LinuxServer('linux-server', `${name}W`); web.powerOn();
  const responder = new LinuxServer('linux-server', `${name}R`); responder.powerOn();
  const cable = new Cable(`${name}c`);
  cable.connect(web.getPort('eth0')!, responder.getPort('eth0')!);
  web.getPort('eth0')!.configureIP(new IPAddress('10.9.0.1'), MASK);
  responder.getPort('eth0')!.configureIP(new IPAddress('10.9.0.2'), MASK);
  await sh(web, `mkdir -p ${CA}`);
  await sh(web, `openssl req -x509 -newkey rsa:1024 -keyout ${CA}/ca.key -out ${CA}/ca.crt -days 365 -nodes -subj "/CN=Lab CA"`);
  await sh(web, `sh -c 'printf "authorityInfoAccess=OCSP;URI:http://10.9.0.2:2560\\n" > /tmp/good.ext'`);
  await sh(web, 'openssl req -new -newkey rsa:1024 -nodes -keyout /tmp/good.key -out /tmp/good.csr -subj "/CN=good.lab"');
  await sh(web, `openssl ca -batch -cert ${CA}/ca.crt -keyfile ${CA}/ca.key -in /tmp/good.csr -extfile /tmp/good.ext -out /tmp/good.crt -days 30`);
  await sh(responder, `mkdir -p ${CA}`);
  for (const file of ['ca.key', 'ca.crt', 'index.txt']) {
    const content = (web as unknown as { executor: { vfs: { readFile(p: string): string | null } } }).executor.vfs.readFile(`${CA}/${file}`)!;
    await (responder as unknown as { executor: { vfs: { writeFile(p: string, c: string, uid: number, gid: number, umask: number): void } } }).executor.vfs.writeFile(`${CA}/${file}`, content, 0, 0, 0o22);
  }
  const startResponder = () => sh(responder, `openssl ocsp -index ${CA}/index.txt -CA ${CA}/ca.crt -rkey ${CA}/ca.key -port 2560 &`);
  if (options.responderUp) await startResponder();
  return { web, responder, cable, startResponder };
}

async function apache(web: LinuxServer, vhost: string): Promise<void> {
  await sh(web, 'a2enmod ssl');
  await sh(web, 'mkdir -p /etc/apache2/conf-available');
  await sh(web, `sh -c 'printf "SSLStaplingCache shmcb:/tmp/stapling(128000)\\n" > /etc/apache2/conf-available/zz.conf'`);
  await sh(web, 'ln -sf ../conf-available/zz.conf /etc/apache2/conf-enabled/zz.conf');
  const body = `<VirtualHost *:443>\n DocumentRoot /var/www/html\n SSLEngine on\n SSLCertificateFile /tmp/good.crt\n SSLCertificateKeyFile /tmp/good.key\n SSLCertificateChainFile ${CA}/ca.crt\n SSLUseStapling on\n${vhost}</VirtualHost>\n`;
  await sh(web, `sh -c 'printf "${body.replace(/\n/g, '\\n')}" > /etc/apache2/sites-available/lab.conf'`);
  await sh(web, 'ln -sf ../sites-available/lab.conf /etc/apache2/sites-enabled/lab.conf');
  await sh(web, 'systemctl start apache2');
}

const status = (web: LinuxServer): Promise<string> => sh(web, `openssl s_client -connect 127.0.0.1:443 -status -CAfile ${CA}/ca.crt`);

describe('agrafage Apache face à un répondeur muet', () => {
  it('témoin : un répondeur sain donne une agrafe « good »', async () => {
    const { web } = await lab('A1');
    await apache(web, '');
    expect(await status(web)).toContain('Cert Status: good');
  });

  it('répondeur muet, réglages par défaut : une réponse tryLater est agrafée (SSLStaplingFakeTryLater on)', async () => {
    const { web } = await lab('A2', { responderUp: false });
    await apache(web, '');
    expect(await status(web)).toMatch(/OCSP Response Status: tryLater \(0x3\)/i);
  });

  it('SSLStaplingFakeTryLater off : aucune agrafe', async () => {
    const { web } = await lab('A3', { responderUp: false });
    await apache(web, ' SSLStaplingFakeTryLater off\n');
    expect(await status(web)).toContain('OCSP response: no response sent');
  });

  it("SSLStaplingReturnResponderErrors off : le tryLater fabriqué n'est pas agrafé", async () => {
    const { web } = await lab('A4', { responderUp: false });
    await apache(web, ' SSLStaplingReturnResponderErrors off\n');
    expect(await status(web)).toContain('OCSP response: no response sent');
  });

  it("SSLStaplingErrorCacheTimeout : l'erreur reste en cache, puis le serveur interroge à nouveau", async () => {
    const { web, startResponder } = await lab('A5', { responderUp: false });
    await apache(web, ' SSLStaplingErrorCacheTimeout 60\n');
    expect(await status(web)).toMatch(/tryLater/i);
    await startResponder();
    expect(await status(web)).toMatch(/tryLater/i);
    PathClock.wait(61_000);
    expect(await status(web)).toContain('Cert Status: good');
  });

  it('SSLStaplingResponderTimeout : un délai de liaison supérieur à la borne donne un tryLater, une borne plus large laisse passer', async () => {
    const tight = await lab('A6');
    await sh(tight.web, 'tc qdisc add dev eth0 root netem delay 3000ms');
    await apache(tight.web, ' SSLStaplingResponderTimeout 2\n');
    expect(await status(tight.web)).toMatch(/tryLater/i);
    const wide = await lab('A7');
    await sh(wide.web, 'tc qdisc add dev eth0 root netem delay 3000ms');
    await apache(wide.web, ' SSLStaplingResponderTimeout 20\n');
    expect(await status(wide.web)).toContain('Cert Status: good');
  });

  it("SSLOCSPProxyURL : l'URL de force est injoignable mais le proxy (ici le répondeur lui-même) répond : « good »", async () => {
    const { web } = await lab('A9');
    await apache(web, ' SSLStaplingForceURL http://10.9.0.99:2560\n SSLOCSPProxyURL http://10.9.0.2:2560\n');
    expect(await status(web)).toContain('Cert Status: good');
  });

  it("SSLOCSPProxyURL : une URL de proxy injoignable fait échouer l'interrogation (tryLater), le proxy est bien le prochain saut", async () => {
    const { web } = await lab('A8');
    await apache(web, ' SSLOCSPProxyURL http://10.9.0.77:3128\n');
    expect(await status(web)).toMatch(/tryLater/i);
  });

  it("SSLOCSPResponderTimeout (certificat client) : une borne plus courte que le délai de liaison refuse le client, une borne large l'accepte", async () => {
    const tight = await lab('B1');
    await sh(tight.web, 'tc qdisc add dev eth0 root netem delay 3000ms');
    await apache(tight.web, ` SSLVerifyClient require\n SSLCACertificateFile ${CA}/ca.crt\n SSLOCSPEnable on\n SSLOCSPResponderTimeout 2\n`);
    expect(await sh(tight.web, 'curl -sS -k --cert /tmp/good.crt --key /tmp/good.key https://127.0.0.1/')).toContain('curl: (');
    const wide = await lab('B2');
    await sh(wide.web, 'tc qdisc add dev eth0 root netem delay 3000ms');
    await apache(wide.web, ` SSLVerifyClient require\n SSLCACertificateFile ${CA}/ca.crt\n SSLOCSPEnable on\n SSLOCSPResponderTimeout 20\n`);
    expect(await sh(wide.web, 'curl -sS -k --cert /tmp/good.crt --key /tmp/good.key https://127.0.0.1/')).toContain('It works!');
  });
});
