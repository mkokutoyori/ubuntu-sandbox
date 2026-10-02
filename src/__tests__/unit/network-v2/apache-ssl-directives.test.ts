/**
 * Apache httpd 2.4 mod_ssl : les directives `SSL*` DÉCIDENT.
 *
 * Source : httpd 2.4.58 (modules/ssl/mod_ssl.c, ssl_engine_config.c,
 * ssl_engine_init.c, ssl_engine_kernel.c) et OpenSSL 3.0.13.
 *
 * MESURÉ avant correctif : `SSLProtocol`, `SSLCipherSuite`,
 * `SSLHonorCipherOrder`, `SSLVerifyClient`, `SSLCACertificateFile`,
 * `SSLSessionCache`, … étaient acceptées par le contrôle de grammaire et
 * IGNORÉES par le serveur (il appliquait les défauts du moteur), les autres
 * directives de mod_ssl (`SSLSessionTickets`, `SSLCARevocationFile`,
 * `SSLOpenSSLConfCmd`, `SSLStrictSNIVHostCheck`, …) étaient refusées comme
 * « Invalid command », `a2enmod ssl` n'activait pas `socache_shmcb`, un seul
 * certificat était présenté pour tout un port, et `SSLCertificateKeyFile`
 * absent n'était refusé qu'au démarrage du service.
 *
 * Avant correctif, 39 des 44 cas tombent ; les cinq témoins passent dans les
 * deux états : le vhost TLS par défaut répond 200, SSLVerifyClient none
 * laisse passer un client sans certificat, une directive hors mod_ssl reste
 * jugée comme avant, et un client muni d'un certificat valide passe sous
 * `require` ou `optional_no_ca` (le serveur ignorait la directive, donc
 * tout passait — ces deux cas ne prouvent que l'absence de régression).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import type { LinuxServer } from '@/network/devices/LinuxServer';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import { PKI, machine, sh, selfSigned, lab, ALICE, MALLORY, exchange } from './_httpsLab';

beforeEach(() => { EquipmentRegistry.getInstance().clear(); });

const VHOST = (extra = '', name = '', cert = 'srv') => `<VirtualHost *:443>
  ${name ? `ServerName ${name}\n  ` : ''}DocumentRoot /var/www/html
  SSLEngine on
  SSLCertificateFile ${PKI}/${cert}.crt
  SSLCertificateKeyFile ${PKI}/${cert}.key
${extra}</VirtualHost>
`;

async function writeSite(srv: LinuxServer, file: string, body: string): Promise<void> {
  const text = body.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n').replace(/\$/g, '\\$');
  await sh(srv, `sh -c 'printf "${text}" > /etc/apache2/sites-available/${file}.conf'`);
  await sh(srv, `ln -sf ../sites-available/${file}.conf /etc/apache2/sites-enabled/${file}.conf`);
}

async function up(srv: LinuxServer, extra = '', global = ''): Promise<string> {
  await sh(srv, 'a2enmod ssl');
  if (global !== '') {
    const text = global.replace(/"/g, '\\"').replace(/\n/g, '\\n');
    await sh(srv, `sh -c 'printf "${text}" > /etc/apache2/conf-available/zz-local.conf' 2>/dev/null; mkdir -p /etc/apache2/conf-available`);
    await sh(srv, `sh -c 'printf "${text}" > /etc/apache2/conf-available/zz-local.conf'`);
    await sh(srv, 'ln -sf ../conf-available/zz-local.conf /etc/apache2/conf-enabled/zz-local.conf');
  }
  await writeSite(srv, 'lab', VHOST(extra));
  const test = await sh(srv, 'apachectl configtest 2>&1');
  if (!test.includes('Syntax OK')) return test;
  await sh(srv, 'systemctl start apache2');
  return test;
}

async function configtest(srv: LinuxServer, extra: string, global = ''): Promise<string> {
  await lab(srv);
  await sh(srv, 'a2enmod ssl');
  if (global !== '') {
    await sh(srv, 'mkdir -p /etc/apache2/conf-available');
    await sh(srv, `sh -c 'printf "${global.replace(/\n/g, '\\n')}" > /etc/apache2/conf-available/zz-local.conf'`);
    await sh(srv, 'ln -sf ../conf-available/zz-local.conf /etc/apache2/conf-enabled/zz-local.conf');
  }
  await writeSite(srv, 'lab', VHOST(extra));
  return sh(srv, 'apachectl configtest 2>&1');
}

const MTLS = (mode: string) => `  SSLVerifyClient ${mode}\n  SSLCACertificateFile ${PKI}/ca.crt\n`;

describe('défauts de mod_ssl (Debian ssl.conf : SSLProtocol all -SSLv3, SSLCipherSuite HIGH:!aNULL)', () => {
  it('témoin : un vhost TLS sans autre directive répond 200', async () => {
    const srv = machine(); await lab(srv); await up(srv);
    expect(await sh(srv, 'curl -sS -k https://127.0.0.1/')).toContain('It works!');
  });

  it('`a2enmod ssl` active aussi ses dépendances setenvif, mime et socache_shmcb', async () => {
    const srv = machine();
    const out = await sh(srv, 'a2enmod ssl');
    expect(out).toContain('Considering dependency socache_shmcb for ssl:');
    expect(out).toContain('Enabling module socache_shmcb.');
    expect(out).toContain('Module setenvif already enabled');
    expect(await sh(srv, 'ls /etc/apache2/mods-enabled')).toContain('socache_shmcb.load');
  });

  it('SSLProtocol all inclut TLSv1.1 : un client TLS 1.1 passe', async () => {
    const srv = machine(); await lab(srv); await up(srv);
    expect(await sh(srv, 'curl -sS -k --tlsv1.1 --tls-max 1.1 https://127.0.0.1/')).toContain('It works!');
  });
});

describe('SSLProtocol (ssl_cmd_protocol_parse, ssl_init_ctx_protocol)', () => {
  it('SSLProtocol -all +TLSv1.3 refuse un client TLS 1.2', async () => {
    const srv = machine(); await lab(srv); await up(srv, '  SSLProtocol -all +TLSv1.3\n');
    expect(await sh(srv, 'curl -sS -k --tlsv1.2 --tls-max 1.2 https://127.0.0.1/')).toContain('curl: (35)');
    expect(await sh(srv, 'curl -sS -k https://127.0.0.1/')).toContain('It works!');
  });

  it('SSLProtocol TLSv1.2 (sans signe) remplace la liste : un client TLS 1.3 seul est refusé', async () => {
    const srv = machine(); await lab(srv); await up(srv, '  SSLProtocol TLSv1.2\n');
    expect(await sh(srv, 'curl -sS -k --tlsv1.3 https://127.0.0.1/')).toContain('curl: (35)');
    expect(await sh(srv, 'curl -sS -k --tlsv1.2 --tls-max 1.2 https://127.0.0.1/')).toContain('It works!');
  });

  it('+TLSv1.1 +TLSv1.3 sans 1.2 : pas de trou entre min et max, donc seul TLS 1.3 reste (1.1 est ignoré)', async () => {
    const srv = machine(); await lab(srv); await up(srv, '  SSLProtocol -all +TLSv1.1 +TLSv1.3\n');
    expect(await sh(srv, 'curl -sS -k --tlsv1.1 --tls-max 1.1 https://127.0.0.1/')).toContain('curl: (35)');
    expect(await sh(srv, 'curl -sS -k --tlsv1.2 --tls-max 1.2 https://127.0.0.1/')).toContain('curl: (35)');
    expect(await sh(srv, 'curl -sS -k https://127.0.0.1/')).toContain('It works!');
  });

  it('+TLSv1.1 +TLSv1.2 +TLSv1.3 : contigus, TLS 1.1 passe', async () => {
    const srv = machine(); await lab(srv); await up(srv, '  SSLProtocol -all +TLSv1.1 +TLSv1.2 +TLSv1.3\n');
    expect(await sh(srv, 'curl -sS -k --tlsv1.1 --tls-max 1.1 https://127.0.0.1/')).toContain('It works!');
  });

  it('un protocole inconnu : « Illegal protocol », SSLv2 « no longer supported », -all seul « No SSL protocols available »', async () => {
    const out = await configtest(machine(), '  SSLProtocol Foo\n');
    expect(out).toContain("SSLProtocol: Illegal protocol 'Foo'");
    EquipmentRegistry.getInstance().clear();
    expect(await configtest(machine(), '  SSLProtocol +SSLv2\n')).toContain('SSLProtocol: SSLv2 is no longer supported');
    EquipmentRegistry.getInstance().clear();
    const srv = machine(); await lab(srv); await sh(srv, 'a2enmod ssl'); await writeSite(srv, 'lab', VHOST('  SSLProtocol -all\n'));
    await sh(srv, 'systemctl start apache2');
    expect(await sh(srv, 'cat /var/log/apache2/error.log')).toContain('AH02231: No SSL protocols available [hint: SSLProtocol]');
  });
});

describe('arité, valeurs, contexte (ap_set_*, ssl_engine_config.c)', () => {
  it('SSLEngine à deux arguments : « takes one argument » suivi de la description de la table', async () => {
    const out = await configtest(machine(), '  SSLEngine on off\n');
    expect(out).toContain("SSLEngine takes one argument, SSL switch for the protocol engine ('on', 'off')");
  });
  it('SSLHonorCipherOrder maybe : « must be On or Off »', async () => {
    expect(await configtest(machine(), '  SSLHonorCipherOrder maybe\n')).toContain('SSLHonorCipherOrder must be On or Off');
  });
  it('SSLVerifyClient maybe : « Invalid argument »', async () => {
    expect(await configtest(machine(), '  SSLVerifyClient maybe\n')).toContain("SSLVerifyClient: Invalid argument 'maybe'");
  });
  it('SSLVerifyDepth -1 : Invalid argument ; SSLSessionCacheTimeout -5 : Invalid argument', async () => {
    expect(await configtest(machine(), '  SSLVerifyDepth -1\n')).toContain("SSLVerifyDepth: Invalid argument '-1'");
    expect(await configtest(machine(), '  SSLSessionCacheTimeout -5\n')).toContain('SSLSessionCacheTimeout: Invalid argument');
  });
  it('SSLCARevocationCheck bogus : Invalid argument', async () => {
    expect(await configtest(machine(), '  SSLCARevocationCheck bogus\n')).toContain("SSLCARevocationCheck: Invalid argument 'bogus'");
  });
  it('SSLSessionCache dans un VirtualHost : « cannot occur within <VirtualHost> section »', async () => {
    expect(await configtest(machine(), '  SSLSessionCache none\n')).toContain('SSLSessionCache cannot occur within <VirtualHost> section');
  });
  it('SSLSessionCache inconnu : known names et module socache à charger', async () => {
    const out = await configtest(machine(), '', 'SSLSessionCache zorglub:/x\n');
    expect(out).toContain("SSLSessionCache: 'zorglub' session cache not supported (known names: shmcb). Maybe you need to load the appropriate socache module (mod_socache_zorglub?).");
  });
  it('SSLCompression on : OpenSSL sans méthode de compression, refusé', async () => {
    expect(await configtest(machine(), '', 'SSLCompression on\n')).toContain('does not have any compression methods available, cannot enable SSLCompression.');
  });
  it('un fichier absent est refusé à la lecture de la configuration : « file ... does not exist or is empty »', async () => {
    const out = await configtest(machine(), `  SSLCACertificateFile ${PKI}/nope.crt\n`);
    expect(out).toContain(`SSLCACertificateFile: file '${PKI}/nope.crt' does not exist or is empty`);
    expect(out).toContain('AH00526');
  });
  it('un répertoire absent : « directory ... does not exist »', async () => {
    expect(await configtest(machine(), '  SSLCACertificatePath /nope\n')).toContain("SSLCACertificatePath: directory '/nope' does not exist");
  });
  it('SSLVerifyClient dans <Directory> exige une renégociation que ce simulateur ne fait pas : refusé en le disant', async () => {
    const out = await configtest(machine(), '  <Directory /var/www/html>\n    SSLVerifyClient require\n  </Directory>\n');
    expect(out).toContain('needs a TLS renegotiation after the handshake, which this simulator does not perform');
  });
  it('témoin : une directive hors mod_ssl reste jugée comme avant', async () => {
    expect(await configtest(machine(), '  Zorglub on\n')).toContain("Invalid command 'Zorglub'");
  });
});

describe('SSLCipherSuite, SSLHonorCipherOrder, SSLOpenSSLConfCmd', () => {
  it('SSLCipherSuite invalide : AH01898 « Unable to configure permitted SSL ciphers »', async () => {
    const srv = machine(); await lab(srv); await sh(srv, 'a2enmod ssl'); await writeSite(srv, 'lab', VHOST('  SSLCipherSuite ZZZ\n'));
    await sh(srv, 'systemctl start apache2');
    expect(await sh(srv, 'cat /var/log/apache2/error.log')).toContain('AH01898: Unable to configure permitted SSL ciphers');
  });

  it('SSLCipherSuite restreint TLS 1.2 à ce que la liste admet', async () => {
    const srv = machine(); await lab(srv);
    await up(srv, '  SSLProtocol TLSv1.2\n  SSLCipherSuite ECDHE-RSA-AES128-GCM-SHA256\n');
    const ok = await exchange(srv, { versions: ['1.2'], cipherList: 'ECDHE-RSA-AES128-GCM-SHA256' } as never);
    expect(ok?.client.negotiatedCipherSuite).toBe('TLS_ECDHE_RSA_WITH_AES_128_GCM_SHA256');
    const none = await exchange(srv, { versions: ['1.2'], cipherList: 'ECDHE-RSA-AES256-GCM-SHA384' } as never);
    expect(none?.client.result).not.toBe('success');
  });

  it('SSLCipherSuite TLSv1.3 fixe les suites TLS 1.3', async () => {
    const srv = machine(); await lab(srv); await up(srv, '  SSLCipherSuite TLSv1.3 TLS_CHACHA20_POLY1305_SHA256\n');
    expect((await exchange(srv, {}))?.client.negotiatedCipherSuite).toBe('TLS_CHACHA20_POLY1305_SHA256');
  });

  it('SSLCipherSuite tiers inconnu : « protocol \'X\' not supported »', async () => {
    expect(await configtest(machine(), '  SSLCipherSuite TLSv9 ALL\n')).toContain("protocol 'TLSv9' not supported");
  });

  it('SSLOpenSSLConfCmd MinProtocol TLSv1.3 refuse TLS 1.2 ; commande inconnue AH02544', async () => {
    const srv = machine(); await lab(srv); await up(srv, '  SSLOpenSSLConfCmd MinProtocol TLSv1.3\n');
    expect(await sh(srv, 'curl -sS -k --tlsv1.2 --tls-max 1.2 https://127.0.0.1/')).toContain('curl: (35)');
    const bad = machine(); await lab(bad); await sh(bad, 'a2enmod ssl'); await writeSite(bad, 'lab', VHOST('  SSLOpenSSLConfCmd Zorglub 1\n'));
    await sh(bad, 'systemctl start apache2');
    expect(await sh(bad, 'cat /var/log/apache2/error.log')).toContain("AH02544: Unable to configure the OpenSSL command 'Zorglub' with value '1'");
  });

  it("SSLOpenSSLConfCmd : « invalid OpenSSL configuration command » n'existe pas pour une commande connue ; le nom est insensible à la casse", async () => {
    const srv = machine(); await lab(srv); await up(srv, '  SSLOpenSSLConfCmd minprotocol TLSv1.3\n');
    expect(await sh(srv, 'curl -sS -k --tlsv1.2 --tls-max 1.2 https://127.0.0.1/')).toContain('curl: (35)');
  });
});

describe('SSLVerifyClient (ssl_init_ctx_verify, ssl_callback_SSLVerify)', () => {
  it('témoin : SSLVerifyClient none laisse passer un client sans certificat', async () => {
    const srv = machine(); await lab(srv); await up(srv, MTLS('none'));
    expect(await sh(srv, 'curl -sS -k https://127.0.0.1/')).toContain('It works!');
  });

  it('require, sans certificat : la poignée de main échoue (alerte, pas une page 400)', async () => {
    const srv = machine(); await lab(srv); await up(srv, MTLS('require'));
    expect(await sh(srv, 'curl -sS -k https://127.0.0.1/')).toContain('curl: (');
    expect((await exchange(srv, {}))?.status).toBe('');
  });

  it('require, certificat de la CA : 200 (TLS 1.3 et TLS 1.2)', async () => {
    const srv = machine(); await lab(srv); await up(srv, MTLS('require'));
    expect(await sh(srv, `curl -sS -k ${ALICE} https://127.0.0.1/`)).toContain('It works!');
    expect(await sh(srv, `curl -sS -k --tlsv1.2 --tls-max 1.2 ${ALICE} https://127.0.0.1/`)).toContain('It works!');
  });

  it('require, certificat d\'une autre CA : refusé à la poignée de main', async () => {
    const srv = machine(); await lab(srv); await up(srv, MTLS('require'));
    expect(await sh(srv, `curl -sS -k ${MALLORY} https://127.0.0.1/`)).toContain('curl: (');
  });

  it('optional : sans certificat 200 ; avec un certificat invalide la poignée de main échoue', async () => {
    const srv = machine(); await lab(srv); await up(srv, MTLS('optional'));
    expect(await sh(srv, 'curl -sS -k https://127.0.0.1/')).toContain('It works!');
    expect(await sh(srv, `curl -sS -k ${MALLORY} https://127.0.0.1/`)).toContain('curl: (');
  });

  it('optional_no_ca : un certificat d\'une CA inconnue est toléré', async () => {
    const srv = machine(); await lab(srv); await up(srv, MTLS('optional_no_ca'));
    expect(await sh(srv, `curl -sS -k ${MALLORY} https://127.0.0.1/`)).toContain('It works!');
  });

  it('SSLCARevocationCheck sans CRL configurée : AH01899', async () => {
    const srv = machine(); await lab(srv); await sh(srv, 'a2enmod ssl');
    await writeSite(srv, 'lab', VHOST(`${MTLS('require')}  SSLCARevocationCheck chain\n`));
    await sh(srv, 'systemctl start apache2');
    expect(await sh(srv, 'cat /var/log/apache2/error.log')).toContain('AH01899: Host *:443: CRL checking has been enabled, but neither SSLCARevocationFile nor SSLCARevocationPath is configured');
  });

  it('SSLCARevocationFile + chain : un certificat révoqué est refusé, avant révocation il passe', async () => {
    const srv = machine(); await lab(srv);
    await sh(srv, `openssl req -new -newkey rsa:1024 -nodes -keyout ${PKI}/dave.key -out ${PKI}/dave.csr -subj "/CN=dave"`);
    await sh(srv, `openssl ca -cert ${PKI}/ca.crt -keyfile ${PKI}/ca.key -in ${PKI}/dave.csr -out ${PKI}/dave.crt -days 30`);
    await sh(srv, `openssl ca -cert ${PKI}/ca.crt -keyfile ${PKI}/ca.key -gencrl -out ${PKI}/ca.crl`);
    await up(srv, `${MTLS('require')}  SSLCARevocationFile ${PKI}/ca.crl\n  SSLCARevocationCheck chain\n`);
    const dave = `--cert ${PKI}/dave.crt --key ${PKI}/dave.key`;
    expect(await sh(srv, `curl -sS -k ${dave} https://127.0.0.1/`)).toContain('It works!');
    await sh(srv, `openssl ca -cert ${PKI}/ca.crt -keyfile ${PKI}/ca.key -revoke ${PKI}/dave.crt`);
    await sh(srv, `openssl ca -cert ${PKI}/ca.crt -keyfile ${PKI}/ca.key -gencrl -out ${PKI}/ca.crl`);
    await sh(srv, 'systemctl restart apache2');
    expect(await sh(srv, `curl -sS -k ${dave} https://127.0.0.1/`)).toContain('curl: (');
  });
});

describe('sessions : SSLSessionCache, SSLSessionTickets, SSLSessionTicketKeyFile', () => {
  const V12 = { versions: ['1.2'] } as never;
  async function resumes(srv: LinuxServer) {
    const first = (await exchange(srv, V12))!;
    const second = (await exchange(srv, { versions: ['1.2'], legacySession: first.client.exportLegacySession() ?? undefined } as never))!;
    return { first, second };
  }

  it('par défaut (cache shmcb de Debian + tickets) : reprise de session', async () => {
    const srv = machine(); await lab(srv); await up(srv);
    expect((await resumes(srv)).second.client.legacyResumed).toBe(true);
  });

  it('SSLSessionTickets off, cache shmcb : reprise par identifiant', async () => {
    const srv = machine(); await lab(srv); await up(srv, '  SSLSessionTickets off\n');
    const { first, second } = await resumes(srv);
    expect(first.client.exportLegacySession()?.ticket ?? '').toBe('');
    expect(second.client.legacyResumed).toBe(true);
  });

  it('SSLSessionTickets off + SSLSessionCache none : aucune reprise', async () => {
    const srv = machine(); await lab(srv); await up(srv, '  SSLSessionTickets off\n', 'SSLSessionCache none\n');
    expect((await resumes(srv)).second.client.legacyResumed).toBe(false);
  });

  it('SSLSessionTicketKeyFile : un fichier de 48 octets est exigé', async () => {
    const srv = machine(); await lab(srv);
    await sh(srv, `sh -c 'printf "short" > ${PKI}/tk'`);
    await sh(srv, 'a2enmod ssl'); await writeSite(srv, 'lab', VHOST(`  SSLSessionTicketKeyFile ${PKI}/tk\n`));
    await sh(srv, 'systemctl start apache2');
    expect(await sh(srv, 'cat /var/log/apache2/error.log')).toContain('it must contain exactly 48 bytes');
  });
});

describe('SNI : un certificat, des protocoles et un contrôle par VirtualHost (init_vhost, ssl_find_vhost)', () => {
  async function twoVhosts(srv: LinuxServer, extraB = '', extraA = ''): Promise<void> {
    await selfSigned(srv, 'srv2', 'b.local');
    await sh(srv, 'a2enmod ssl');
    await writeSite(srv, 'a', VHOST(extraA, 'lab.local', 'srv'));
    await writeSite(srv, 'b', VHOST(extraB, 'b.local', 'srv2'));
    await sh(srv, 'systemctl start apache2');
  }

  it('b.local reçoit son certificat, lab.local celui du premier vhost', async () => {
    const srv = machine(); await lab(srv); await twoVhosts(srv);
    expect((await exchange(srv, {}, 'b.local'))?.client.peerCertificate?.subject).toBe('CN=b.local');
    expect((await exchange(srv, {}, 'lab.local'))?.client.peerCertificate?.subject).toBe('CN=lab.local');
  });

  it('SSLProtocol propre au vhost (protocol_set) : b.local exige TLS 1.3, lab.local accepte TLS 1.2', async () => {
    const srv = machine(); await lab(srv); await twoVhosts(srv, '  SSLProtocol -all +TLSv1.3\n');
    expect((await exchange(srv, { versions: ['1.2'] } as never, 'lab.local'))?.status).toContain('200');
    const refused = await exchange(srv, { versions: ['1.2'] } as never, 'b.local');
    expect(refused?.client.peerAlert?.description).toBe('protocol_version');
    expect((await exchange(srv, {}, 'b.local'))?.status).toContain('200');
  });

  it('ServerAlias générique (*.zone) choisit son vhost, et le certificat qui va avec', async () => {
    const srv = machine(); await lab(srv); await selfSigned(srv, 'srv2', 'b.local');
    await sh(srv, 'a2enmod ssl');
    await writeSite(srv, 'a', VHOST('', 'lab.local', 'srv'));
    await writeSite(srv, 'b', VHOST('  ServerAlias *.zone\n', 'b.local', 'srv2'));
    await sh(srv, 'systemctl start apache2');
    expect((await exchange(srv, {}, 'x.zone'))?.client.peerCertificate?.subject).toBe('CN=b.local');
  });

  it('SSLStrictSNIVHostCheck on : un client sans SNI sur un hôte à noms reçoit 403', async () => {
    const srv = machine(); await lab(srv); await twoVhosts(srv, '', '  SSLStrictSNIVHostCheck on\n');
    const noSni = await exchange(srv, { serverName: undefined } as never, 'lab.local');
    expect(noSni?.status).toContain('403');
    expect((await exchange(srv, {}, 'lab.local'))?.status).toContain('200');
  });

  it('SNI b.local avec Host lab.local : 421 si les réglages TLS diffèrent, 200 s\'ils sont compatibles', async () => {
    const srv = machine(); await lab(srv); await twoVhosts(srv, '  SSLProtocol -all +TLSv1.3\n');
    const incompatible = await exchange(srv, {}, 'b.local', '/', 443, 'lab.local');
    expect(incompatible?.status).toContain('421');
    EquipmentRegistry.getInstance().clear();
    const same = machine(); await lab(same); await twoVhosts(same);
    expect((await exchange(same, {}, 'b.local', '/', 443, 'lab.local'))?.status).toContain('200');
  });

  it('SNI sans Host dans la requête : 400 (AH02031)', async () => {
    const srv = machine(); await lab(srv); await twoVhosts(srv);
    const out = await exchange(srv, {}, 'b.local', '/', 443, '');
    expect(out?.status).toContain('400');
    expect(await sh(srv, 'cat /var/log/apache2/error.log')).toContain('AH02031: Hostname b.local provided via SNI, but no hostname provided in HTTP request');
  });
});
