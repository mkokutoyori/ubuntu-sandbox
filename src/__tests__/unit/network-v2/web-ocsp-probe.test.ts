/**
 * OCSP côté serveur web et client.
 *
 * Source : nginx 1.24.0 (ngx_event_openssl_stapling.c, ngx_event_openssl_ocsp.c,
 * ngx_http_request.c), Apache httpd 2.4.58 (ssl_util_stapling.c,
 * ssl_engine_kernel.c, ssl_engine_config.c), curl 8.5.0 (lib/vtls/openssl.c
 * verifystatus) et OpenSSL 3.0.13 (apps/s_client.c).
 *
 * MESURÉ avant correctif : `ssl_stapling on` sans fichier, `ssl_ocsp`,
 * `ssl_stapling_responder`, `ssl_ocsp_responder` étaient refusés (« not
 * supported by this simulator ») ; `SSLUseStapling`, `SSLOCSPEnable` et leurs
 * quinze voisines n'existaient pas ; `curl --cert-status` et
 * `openssl s_client -status` étaient inconnus ; `openssl ca` ignorait
 * `-extfile`, donc aucun certificat ne portait d'URL de répondeur.
 *
 * Avant correctif, 16 des 18 cas tombent ; deux témoins passent dans les deux
 * états : un serveur sans agrafage répond 200 ; un client révoqué passe sans
 * ssl_ocsp. Deux défauts de socle ont été trouvés en route : `openssl ca`
 * ne déclarait pas `-extfile` comme option à valeur (le fichier devenait un
 * opérande, aucune extension AIA n'entrait dans le certificat) ; et une
 * requête TCP ouverte pendant une poignée de main restait sans réponse dès
 * que celle-ci dépassait un segment, l'ACK dû n'étant vidé qu'à la fin de la
 * rafale extérieure.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';

beforeEach(() => { EquipmentRegistry.getInstance().clear(); });

const CA = '/etc/ssl/CA';
const URL = 'http://127.0.0.1:2560';

async function sh(srv: LinuxServer, command: string): Promise<string> {
  return srv.executeCommand(command);
}

async function issue(srv: LinuxServer, name: string, usage = ''): Promise<void> {
  await sh(srv, `sh -c 'printf "authorityInfoAccess=OCSP;URI:${URL}\\n${usage}" > /tmp/${name}.ext'`);
  await sh(srv, `openssl req -new -newkey rsa:1024 -nodes -keyout /tmp/${name}.key -out /tmp/${name}.csr -subj "/CN=${name}.lab"`);
  await sh(srv, `openssl ca -cert ${CA}/ca.crt -keyfile ${CA}/ca.key -in /tmp/${name}.csr -extfile /tmp/${name}.ext -out /tmp/${name}.crt -days 30`);
}

async function lab(): Promise<LinuxServer> {
  const srv = new LinuxServer('linux-server', 'W'); srv.powerOn();
  await sh(srv, `mkdir -p ${CA}`);
  await sh(srv, `openssl req -x509 -newkey rsa:1024 -keyout ${CA}/ca.key -out ${CA}/ca.crt -days 365 -nodes -subj "/CN=Lab CA"`);
  await issue(srv, 'good');
  await issue(srv, 'bad');
  await sh(srv, `openssl ca -cert ${CA}/ca.crt -keyfile ${CA}/ca.key -revoke /tmp/bad.crt`);
  await sh(srv, `openssl ocsp -index ${CA}/index.txt -CA ${CA}/ca.crt -rkey ${CA}/ca.key -port 2560 &`);
  return srv;
}

async function nginx(srv: LinuxServer, name: string, extra: string): Promise<string> {
  const body = `server {\n listen 443 ssl;\n root /var/www/html;\n index index.nginx-debian.html;\n ssl_certificate /tmp/${name}.crt;\n ssl_certificate_key /tmp/${name}.key;\n${extra}}\n`;
  await sh(srv, `sh -c 'printf "${body.replace(/\n/g, '\\n')}" > /etc/nginx/sites-available/default'`);
  const test = await sh(srv, 'nginx -t');
  await sh(srv, 'systemctl start nginx');
  return test;
}

const STAPLING = `ssl_stapling on;\n ssl_stapling_verify on;\n ssl_trusted_certificate ${CA}/ca.crt;\n`;

describe('nginx : agrafage dynamique (ssl_stapling sans fichier)', () => {
  it('témoin : un serveur sans agrafage répond 200 ; curl sans --cert-status ignore l\'agrafe', async () => {
    const srv = await lab(); await nginx(srv, 'good', '');
    expect(await sh(srv, 'curl -sS -k https://127.0.0.1/')).toContain('Welcome to nginx!');
  });

  it('le serveur interroge le répondeur de l\'AIA par TCP et agrafe « good » : curl --cert-status passe', async () => {
    const srv = await lab(); await nginx(srv, 'good', STAPLING);
    expect(await sh(srv, `curl -sS --cacert ${CA}/ca.crt --resolve good.lab:443:127.0.0.1 --cert-status https://good.lab/`)).toContain('Welcome to nginx!');
  });

  it('certificat révoqué : « SSL certificate revocation reason » (91)', async () => {
    const srv = await lab(); await nginx(srv, 'bad', STAPLING);
    expect(await sh(srv, `curl -sS --cacert ${CA}/ca.crt --resolve bad.lab:443:127.0.0.1 --cert-status https://bad.lab/`)).toContain('curl: (91) SSL certificate revocation reason: unspecified (0)');
  });

  it('sans agrafage, --cert-status : « No OCSP response received » (91)', async () => {
    const srv = await lab(); await nginx(srv, 'good', '');
    expect(await sh(srv, `curl -sS --cacert ${CA}/ca.crt --resolve good.lab:443:127.0.0.1 --cert-status https://good.lab/`)).toContain('curl: (91) No OCSP response received');
  });

  it('un répondeur arrêté : aucun agrafage, --cert-status échoue', async () => {
    const srv = new LinuxServer('linux-server', 'W2'); srv.powerOn();
    await sh(srv, `mkdir -p ${CA}`);
    await sh(srv, `openssl req -x509 -newkey rsa:1024 -keyout ${CA}/ca.key -out ${CA}/ca.crt -days 365 -nodes -subj "/CN=Lab CA"`);
    await issue(srv, 'good'); await nginx(srv, 'good', STAPLING);
    expect(await sh(srv, `curl -sS --cacert ${CA}/ca.crt --resolve good.lab:443:127.0.0.1 --cert-status https://good.lab/`)).toContain('curl: (91) No OCSP response received');
  });

  it('ssl_stapling_responder prime sur l\'AIA ; une URL non http est refusée à nginx -t', async () => {
    const srv = await lab();
    expect(await nginx(srv, 'good', `${STAPLING} ssl_stapling_responder http://127.0.0.1:2560;\n`)).toContain('successful');
    const bad = await nginx(srv, 'good', ' ssl_stapling_responder ftp://x;\n');
    expect(bad).toContain('invalid URL prefix in "ftp://x"');
  });

  it('sans URL de répondeur dans le certificat : [warn] « no OCSP responder URL in the certificate »', async () => {
    const srv = await lab();
    await sh(srv, `openssl req -x509 -newkey rsa:1024 -keyout /tmp/plain.key -out /tmp/plain.crt -days 30 -nodes -subj "/CN=plain.lab"`);
    await nginx(srv, 'plain', `ssl_stapling on;\n ssl_trusted_certificate /tmp/plain.crt;\n`);
    expect(await sh(srv, 'cat /var/log/nginx/error.log')).toContain('"ssl_stapling" ignored, no OCSP responder URL in the certificate "/tmp/plain.crt"');
  });
});

describe('nginx : ssl_ocsp pour les certificats clients', () => {
  const MTLS = (mode: string) => ` ssl_verify_client on;\n ssl_client_certificate ${CA}/ca.crt;\n ssl_ocsp ${mode};\n`;

  it('ssl_ocsp on : client good 200, client révoqué 400 « The SSL certificate error » (495)', async () => {
    const srv = await lab(); await issue(srv, 'srv');
    await nginx(srv, 'srv', MTLS('on'));
    expect(await sh(srv, 'curl -sS -k --cert /tmp/good.crt --key /tmp/good.key https://127.0.0.1/')).toContain('Welcome to nginx!');
    expect(await sh(srv, 'curl -sS -k --cert /tmp/bad.crt --key /tmp/bad.key https://127.0.0.1/')).toContain('400 The SSL certificate error');
  });

  it('témoin : sans ssl_ocsp le client révoqué passe', async () => {
    const srv = await lab(); await issue(srv, 'srv');
    await nginx(srv, 'srv', ` ssl_verify_client on;\n ssl_client_certificate ${CA}/ca.crt;\n`);
    expect(await sh(srv, 'curl -sS -k --cert /tmp/bad.crt --key /tmp/bad.key https://127.0.0.1/')).toContain('Welcome to nginx!');
  });

  it('ssl_ocsp_responder prime sur l\'AIA : un répondeur injoignable donne 495', async () => {
    const srv = await lab(); await issue(srv, 'srv');
    await nginx(srv, 'srv', `${MTLS('leaf')} ssl_ocsp_responder http://127.0.0.1:9999;\n`);
    expect(await sh(srv, 'curl -sS -k --cert /tmp/good.crt --key /tmp/good.key https://127.0.0.1/')).toContain('400 The SSL certificate error');
  });

  it('ssl_ocsp avec optional_no_ca : « is incompatible » ; valeur inconnue : invalid value', async () => {
    const srv = await lab(); await issue(srv, 'srv');
    expect(await nginx(srv, 'srv', ` ssl_verify_client optional_no_ca;\n ssl_ocsp on;\n`)).toContain('"ssl_ocsp" is incompatible with "ssl_verify_client optional_no_ca"');
    expect(await nginx(srv, 'srv', ' ssl_ocsp maybe;\n')).toContain('invalid value "maybe"');
  });
});

describe('Apache : SSLUseStapling et SSLOCSPEnable', () => {
  async function apache(srv: LinuxServer, name: string, vhost: string, global = ''): Promise<string> {
    await sh(srv, 'a2enmod ssl');
    await sh(srv, 'mkdir -p /etc/apache2/conf-available');
    await sh(srv, `sh -c 'printf "${global.replace(/\n/g, '\\n')}" > /etc/apache2/conf-available/zz.conf'`);
    await sh(srv, 'ln -sf ../conf-available/zz.conf /etc/apache2/conf-enabled/zz.conf');
    const body = `<VirtualHost *:443>\n DocumentRoot /var/www/html\n SSLEngine on\n SSLCertificateFile /tmp/${name}.crt\n SSLCertificateKeyFile /tmp/${name}.key\n${vhost}</VirtualHost>\n`;
    await sh(srv, `sh -c 'printf "${body.replace(/\n/g, '\\n')}" > /etc/apache2/sites-available/lab.conf'`);
    await sh(srv, 'ln -sf ../sites-available/lab.conf /etc/apache2/sites-enabled/lab.conf');
    const test = await sh(srv, 'apachectl configtest 2>&1');
    await sh(srv, 'systemctl start apache2');
    return test;
  }
  const CACHE = 'SSLStaplingCache shmcb:/tmp/stapling(128000)\n';

  it('SSLUseStapling on : l\'agrafe « good » est vérifiée par curl --cert-status', async () => {
    const srv = await lab();
    await apache(srv, 'good', ` SSLUseStapling on\n SSLCertificateChainFile ${CA}/ca.crt\n`, CACHE);
    expect(await sh(srv, `curl -sS --cacert ${CA}/ca.crt --resolve good.lab:443:127.0.0.1 --cert-status https://good.lab/`)).toContain('It works!');
  });

  it('SSLUseStapling on, certificat révoqué : curl --cert-status échoue (91)', async () => {
    const srv = await lab();
    await apache(srv, 'bad', ` SSLUseStapling on\n SSLCertificateChainFile ${CA}/ca.crt\n`, CACHE);
    expect(await sh(srv, `curl -sS --cacert ${CA}/ca.crt --resolve bad.lab:443:127.0.0.1 --cert-status https://bad.lab/`)).toContain('curl: (91) SSL certificate revocation reason');
  });

  it('SSLUseStapling sans SSLStaplingCache : AH01958 au démarrage', async () => {
    const srv = await lab();
    await apache(srv, 'good', ` SSLUseStapling on\n SSLCertificateChainFile ${CA}/ca.crt\n`);
    expect(await sh(srv, 'cat /var/log/apache2/error.log')).toContain('AH01958: SSLStapling: no stapling cache available');
  });

  it('SSLOCSPEnable on : un client révoqué est refusé à la poignée de main, un client good passe', async () => {
    const srv = await lab(); await issue(srv, 'srv');
    await apache(srv, 'srv', ` SSLVerifyClient require\n SSLCACertificateFile ${CA}/ca.crt\n SSLOCSPEnable on\n`);
    expect(await sh(srv, 'curl -sS -k --cert /tmp/good.crt --key /tmp/good.key https://127.0.0.1/')).toContain('It works!');
    expect(await sh(srv, 'curl -sS -k --cert /tmp/bad.crt --key /tmp/bad.key https://127.0.0.1/')).toContain('curl: (');
  });

  it('arguments : SSLOCSPEnable bogus ; SSLOCSPResponseMaxAge -1', async () => {
    const srv = await lab();
    expect(await apache(srv, 'good', ' SSLOCSPEnable bogus\n')).toContain("SSLOCSPEnable: Invalid argument 'bogus'");
    expect(await apache(srv, 'good', ' SSLOCSPResponseMaxAge -1\n')).toContain('SSLOCSPResponseMaxAge: invalid argument');
  });
});

describe('openssl s_client -status', () => {
  it('affiche la réponse OCSP agrafée par le serveur', async () => {
    const srv = await lab(); await nginx(srv, 'good', STAPLING);
    const out = await sh(srv, `openssl s_client -connect 127.0.0.1:443 -status -CAfile ${CA}/ca.crt`);
    expect(out).toContain('OCSP response:');
    expect(out).toContain('OCSP Response Status: successful (0x0)');
    expect(out).toContain('Cert Status: good');
  });

  it('sans agrafage : « OCSP response: no response sent »', async () => {
    const srv = await lab(); await nginx(srv, 'good', '');
    expect(await sh(srv, `openssl s_client -connect 127.0.0.1:443 -status -CAfile ${CA}/ca.crt`)).toContain('OCSP response: no response sent');
  });
});
