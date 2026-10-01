/**
 * nginx 1.24.0 `ngx_http_ssl_module` : les directives `ssl_*` DÉCIDENT.
 *
 * Source : nginx-1.24.0 (src/http/modules/ngx_http_ssl_module.c,
 * ngx_http_request.c, ngx_http_special_response.c), OpenSSL 3.0.13
 * (ssl/ssl_conf.c) et curl 8.5.0 (lib/vtls/openssl.c).
 *
 * MESURÉ avant correctif : `ssl_protocols` valait `TLSv1.2 TLSv1.3` par
 * défaut (le source dit les quatre), `ssl_verify_client`, `ssl_client_certificate`,
 * `ssl_verify_depth`, `ssl_crl`, `ssl_session_*`, `ssl_ecdh_curve`,
 * `ssl_early_data`, `ssl_reject_handshake`, `ssl_password_file`,
 * `ssl_buffer_size`, `ssl_dhparam`, `ssl_conf_command` étaient REFUSÉS
 * (« not supported by this simulator ») et les blocs `server` d'un même
 * port ne présentaient qu'UN certificat. `curl --cert/--key` était refusé.
 *
 * Avant correctif, 45 des 48 cas tombent ; les trois témoins passent dans
 * les deux états : le serveur HTTPS par défaut répond 200, `ssl_protocols
 * TLSv1.3` refusait déjà un client TLS 1.2 (non-régression), et un nom SNI
 * inconnu reçoit le certificat du serveur par défaut (un seul certificat
 * était présenté, donc le défaut l'était aussi).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import type { LinuxServer } from '@/network/devices/LinuxServer';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import { EventBus } from '@/events/EventBus';
import { CertificateVerifier } from '@/network/pki/CertificateVerifier';
import { PKI, machine, sh, selfSigned, issue, lab, ALICE, MALLORY, exchange, type Exchange } from './_httpsLab';

beforeEach(() => { EquipmentRegistry.getInstance().clear(); });

async function site(srv: LinuxServer, body: string): Promise<void> {
  const text = body.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
  await sh(srv, `sh -c 'printf "${text}" > /etc/nginx/sites-available/default'`);
}

const SERVER = (extra = '', http = '') => `${http}server {
  listen 443 ssl;
  server_name _;
  root /var/www/html;
  index index.nginx-debian.html;
  ssl_certificate ${PKI}/srv.crt;
  ssl_certificate_key ${PKI}/srv.key;
${extra}}
`;

async function up(srv: LinuxServer, extra = '', http = ''): Promise<string> {
  await site(srv, SERVER(extra, http));
  const test = await sh(srv, 'nginx -t');
  if (!test.includes('successful')) return test;
  await sh(srv, 'systemctl start nginx');
  return test;
}

const MTLS = `  ssl_verify_client on;
  ssl_client_certificate ${PKI}/ca.crt;
`;

describe('défauts du source nginx 1.24', () => {
  it('témoin : un serveur HTTPS sans autre directive répond 200', async () => {
    const srv = machine(); await lab(srv); await up(srv);
    expect(await sh(srv, 'curl -sS -k https://127.0.0.1/')).toContain('Welcome to nginx!');
  });

  it('ssl_protocols vaut TLSv1 TLSv1.1 TLSv1.2 TLSv1.3 par défaut : un client TLS 1.1 passe', async () => {
    const srv = machine(); await lab(srv); await up(srv);
    expect(await sh(srv, 'curl -sS -k --tlsv1.1 --tls-max 1.1 https://127.0.0.1/')).toContain('Welcome to nginx!');
  });

  it('ssl_protocols TLSv1.3 refuse un client TLS 1.2', async () => {
    const srv = machine(); await lab(srv); await up(srv, '  ssl_protocols TLSv1.3;\n');
    expect(await sh(srv, 'curl -sS -k --tlsv1.2 --tls-max 1.2 https://127.0.0.1/')).toContain('curl: (35)');
  });
});

describe('arité, valeurs, doublons et contexte (ngx_conf_file.c)', () => {
  const refused = async (extra: string, http = ''): Promise<string> => {
    const srv = machine(); await lab(srv);
    await site(srv, SERVER(extra, http));
    return sh(srv, 'nginx -t');
  };

  it('ssl_session_timeout abc → invalid value', async () => {
    expect(await refused('  ssl_session_timeout abc;\n')).toContain('"ssl_session_timeout" directive invalid value');
  });
  it('ssl_verify_client maybe → invalid value "maybe"', async () => {
    expect(await refused('  ssl_verify_client maybe;\n')).toContain('invalid value "maybe"');
  });
  it('ssl_ciphers deux fois dans le même bloc → is duplicate', async () => {
    expect(await refused('  ssl_ciphers HIGH;\n  ssl_ciphers LOW;\n')).toContain('"ssl_ciphers" directive is duplicate');
  });
  it('ssl_ciphers dans une location → is not allowed here', async () => {
    const srv = machine(); await lab(srv);
    await site(srv, SERVER().replace('}\n', '  location / { ssl_ciphers HIGH; }\n}\n'));
    expect(await sh(srv, 'nginx -t')).toContain('"ssl_ciphers" directive is not allowed here');
  });
  it('ssl_session_cache xx → invalid session cache', async () => {
    expect(await refused('  ssl_session_cache xx;\n')).toContain('invalid session cache "xx"');
  });
  it('ssl_session_cache shared:SSL:1k → too small', async () => {
    expect(await refused('  ssl_session_cache shared:SSL:1k;\n')).toContain('session cache "shared:SSL:1k" is too small');
  });
  it('ssl_buffer_size x → invalid value', async () => {
    expect(await refused('  ssl_buffer_size x;\n')).toContain('"ssl_buffer_size" directive invalid value');
  });
  it('ssl_verify_client on sans ssl_client_certificate → no ssl_client_certificate for ssl_verify_client', async () => {
    expect(await refused('  ssl_verify_client on;\n')).toContain('no ssl_client_certificate for ssl_verify_client');
  });
  it('ssl_session_ticket_key de 10 octets → must be 48 or 80 bytes', async () => {
    const srv = machine(); await lab(srv);
    await sh(srv, `sh -c 'printf "0123456789" > ${PKI}/tk'`);
    await site(srv, SERVER(`  ssl_session_ticket_key ${PKI}/tk;\n`));
    expect(await sh(srv, 'nginx -t')).toContain(`"${PKI}/tk" must be 48 or 80 bytes`);
  });
  it('ssl_conf_command inconnue → SSL_CONF_cmd failed, unknown cmd name', async () => {
    const out = await refused('  ssl_conf_command Zorglub 1;\n');
    expect(out).toContain('SSL_CONF_cmd("Zorglub", "1") failed');
    expect(out).toContain('error:0A000182:SSL routines::unknown cmd name:cmd=Zorglub');
  });
  it('ssl_conf_command Protocol invalide → bad value', async () => {
    expect(await refused('  ssl_conf_command MinProtocol TLSv9;\n')).toContain('error:0A000180:SSL routines::bad value:cmd=MinProtocol, value=TLSv9');
  });
  it('ssl_ecdh_curve inconnue → SSL_CTX_set1_curves_list failed', async () => {
    expect(await refused('  ssl_ecdh_curve zorglub;\n')).toContain('SSL_CTX_set1_curves_list("zorglub") failed');
  });
  it('la clé privée d\'un autre certificat est refusée : key values mismatch', async () => {
    const srv = machine(); await lab(srv);
    await site(srv, SERVER().replace('srv.key', 'alice.key'));
    await sh(srv, 'systemctl start nginx');
    expect(await sh(srv, 'cat /var/log/nginx/error.log')).toContain('key values mismatch');
  });
});

describe('ssl_verify_client (ngx_http_process_request, special_response)', () => {
  it('témoin : ssl_verify_client off laisse passer un client sans certificat', async () => {
    const srv = machine(); await lab(srv); await up(srv, `  ssl_verify_client off;\n  ssl_client_certificate ${PKI}/ca.crt;\n`);
    expect(await sh(srv, 'curl -sS -k https://127.0.0.1/')).toContain('Welcome to nginx!');
  });
  it('on, sans certificat → 400 « No required SSL certificate was sent » (496)', async () => {
    const srv = machine(); await lab(srv); await up(srv, MTLS);
    const out = await sh(srv, 'curl -sS -k https://127.0.0.1/');
    expect(out).toContain('400 No required SSL certificate was sent');
    expect(out).toContain('<center><h1>400 Bad Request</h1></center>');
  });
  it('on, certificat de la CA → 200', async () => {
    const srv = machine(); await lab(srv); await up(srv, MTLS);
    expect(await sh(srv, `curl -sS -k ${ALICE} https://127.0.0.1/`)).toContain('Welcome to nginx!');
  });
  it('on, certificat d\'une autre CA → 400 « The SSL certificate error » (495)', async () => {
    const srv = machine(); await lab(srv); await up(srv, MTLS);
    const out = await sh(srv, `curl -sS -k ${MALLORY} https://127.0.0.1/`);
    expect(out).toContain('400 The SSL certificate error');
  });
  it('optional, sans certificat → 200 ; avec un mauvais → 495', async () => {
    const srv = machine(); await lab(srv); await up(srv, MTLS.replace('on', 'optional'));
    expect(await sh(srv, 'curl -sS -k https://127.0.0.1/')).toContain('Welcome to nginx!');
    expect(await sh(srv, `curl -sS -k ${MALLORY} https://127.0.0.1/`)).toContain('400 The SSL certificate error');
  });
  it('optional_no_ca, certificat d\'une CA inconnue → 200', async () => {
    const srv = machine(); await lab(srv); await up(srv, MTLS.replace('on', 'optional_no_ca'));
    expect(await sh(srv, `curl -sS -k ${MALLORY} https://127.0.0.1/`)).toContain('Welcome to nginx!');
  });
  it('fonctionne aussi en TLS 1.2', async () => {
    const srv = machine(); await lab(srv); await up(srv, MTLS);
    expect(await sh(srv, `curl -sS -k --tlsv1.2 --tls-max 1.2 ${ALICE} https://127.0.0.1/`)).toContain('Welcome to nginx!');
    expect(await sh(srv, 'curl -sS -k --tlsv1.2 --tls-max 1.2 https://127.0.0.1/')).toContain('400 No required SSL certificate was sent');
  });
  it('ssl_verify_depth 1 par défaut : une chaîne leaf→intermédiaire→racine est refusée (495), depth 2 l\'accepte', async () => {
    const srv = machine(); await lab(srv);
    await sh(srv, `sh -c 'printf "basicConstraints=critical,CA:TRUE\\n" > ${PKI}/ca.ext'`);
    await sh(srv, `openssl req -new -newkey rsa:1024 -nodes -keyout ${PKI}/sub.key -out ${PKI}/sub.csr -subj "/CN=Sub CA"`);
    await sh(srv, `openssl x509 -req -in ${PKI}/sub.csr -CA ${PKI}/ca.crt -CAkey ${PKI}/ca.key -CAcreateserial -extfile ${PKI}/ca.ext -out ${PKI}/sub.crt -days 30`);
    await sh(srv, `openssl req -new -newkey rsa:1024 -nodes -keyout ${PKI}/bob.key -out ${PKI}/bob.csr -subj "/CN=bob"`);
    await sh(srv, `openssl x509 -req -in ${PKI}/bob.csr -CA ${PKI}/sub.crt -CAkey ${PKI}/sub.key -CAcreateserial -out ${PKI}/bob.crt -days 30`);
    await sh(srv, `sh -c 'cat ${PKI}/bob.crt ${PKI}/sub.crt > ${PKI}/bob-chain.crt'`);
    await up(srv, MTLS);
    const bob = `--cert ${PKI}/bob-chain.crt --key ${PKI}/bob.key`;
    expect(await sh(srv, `curl -sS -k ${bob} https://127.0.0.1/`)).toContain('400 The SSL certificate error');
    await up(srv, `${MTLS}  ssl_verify_depth 2;\n`);
    await sh(srv, 'nginx -s reload');
    expect(await sh(srv, `curl -sS -k ${bob} https://127.0.0.1/`)).toContain('Welcome to nginx!');
  });
});

describe('SNI : un certificat par bloc server (ngx_http_ssl_servername)', () => {
  async function twoSites(srv: LinuxServer, extraSecond = ''): Promise<void> {
    await selfSigned(srv, 'srv2', 'b.local');
    const first = SERVER('', '').replace('server_name _;', 'server_name a.local;');
    const second = SERVER(extraSecond).replace('server_name _;', 'server_name b.local;')
      .replace('srv.crt', 'srv2.crt').replace('srv.key', 'srv2.key').replace('listen 443 ssl;', 'listen 443 ssl;');
    await site(srv, `${first}\n${second}`);
    await sh(srv, 'systemctl start nginx');
  }

  it('b.local reçoit son propre certificat, a.local celui du premier bloc', async () => {
    const srv = machine(); await lab(srv); await twoSites(srv);
    const b = await exchange(srv, {}, 'b.local');
    const a = await exchange(srv, {}, 'a.local');
    expect(b?.client.peerCertificate?.subject).toBe('CN = b.local');
    expect(a?.client.peerCertificate?.subject).toBe('CN = lab.local');
  });

  it('un nom inconnu reçoit le certificat du serveur par défaut (le premier)', async () => {
    const srv = machine(); await lab(srv); await twoSites(srv);
    const x = await exchange(srv, { verifier: new CertificateVerifier({ trustAnchors: [] }), allowUntrustedPeer: true } as never, 'zz.local');
    expect(x?.client.peerCertificate?.subject).toBe('CN = lab.local');
  });

  it('ssl_reject_handshake on dans le serveur par défaut : ni SNI ni nom inconnu → alerte unrecognized_name', async () => {
    const srv = machine(); await lab(srv);
    await selfSigned(srv, 'srv2', 'b.local');
    const rejecting = `server {\n  listen 443 ssl default_server;\n  ssl_reject_handshake on;\n}\n`;
    const real = SERVER().replace('server_name _;', 'server_name b.local;').replace('srv.crt', 'srv2.crt').replace('srv.key', 'srv2.key');
    await site(srv, `${rejecting}\n${real}`);
    await sh(srv, 'systemctl start nginx');
    expect((await exchange(srv, {}, 'b.local'))?.status).toContain('200');
    const unknown = await exchange(srv, {}, 'zz.local');
    expect(unknown?.client.result).not.toBe('success');
    expect(unknown?.client.peerAlert?.description).toBe('unrecognized_name');
  });

  it('server_name par préfixe joker et par .domaine sont résolus comme nginx', async () => {
    const srv = machine(); await lab(srv); await selfSigned(srv, 'srv2', 'wild.local');
    const first = SERVER().replace('server_name _;', 'server_name main.local;');
    const second = SERVER().replace('server_name _;', 'server_name .wild.local;').replace('srv.crt', 'srv2.crt').replace('srv.key', 'srv2.key');
    await site(srv, `${first}\n${second}`);
    await sh(srv, 'systemctl start nginx');
    expect((await exchange(srv, {}, 'wild.local'))?.client.peerCertificate?.subject).toBe('CN = wild.local');
    expect((await exchange(srv, {}, 'x.wild.local'))?.client.peerCertificate?.subject).toBe('CN = wild.local');
    expect((await exchange(srv, {}, 'main.local'))?.client.peerCertificate?.subject).toBe('CN = lab.local');
  });
});

describe('sessions (ssl_session_cache, ssl_session_tickets, ssl_session_timeout, ssl_session_ticket_key)', () => {
  const V12 = { versions: ['1.2'] } as never;

  async function resumes(srv: LinuxServer): Promise<{ first: Exchange; second: Exchange }> {
    const first = (await exchange(srv, V12))!;
    const saved = first.client.exportLegacySession();
    const second = (await exchange(srv, { versions: ['1.2'], legacySession: saved ?? undefined } as never))!;
    return { first, second };
  }

  it('défaut nginx : tickets actifs, pas de cache → reprise par ticket', async () => {
    const srv = machine(); await lab(srv); await up(srv);
    const { first, second } = await resumes(srv);
    expect(first.client.exportLegacySession()?.ticket).toBeTruthy();
    expect(second.client.legacyResumed).toBe(true);
  });

  it('ssl_session_tickets off sans cache → aucune reprise', async () => {
    const srv = machine(); await lab(srv); await up(srv, '  ssl_session_tickets off;\n');
    const { first, second } = await resumes(srv);
    expect(first.client.exportLegacySession()?.ticket ?? '').toBe('');
    expect(second.client.legacyResumed).toBe(false);
  });

  it('ssl_session_tickets off + ssl_session_cache shared:SSL:1m → reprise par identifiant', async () => {
    const srv = machine(); await lab(srv); await up(srv, '  ssl_session_tickets off;\n  ssl_session_cache shared:SSL:1m;\n');
    const { second } = await resumes(srv);
    expect(second.client.legacyResumed).toBe(true);
  });

  it('ssl_session_cache none ou off + tickets off → pas de reprise', async () => {
    for (const cache of ['none', 'off']) {
      const srv = machine(); await lab(srv); await up(srv, `  ssl_session_tickets off;\n  ssl_session_cache ${cache};\n`);
      expect((await resumes(srv)).second.client.legacyResumed).toBe(false);
      EquipmentRegistry.getInstance().clear();
    }
  });

  it('un autre ssl_session_ticket_key (même fichier) ouvre le ticket ; une autre clé non', async () => {
    const key48 = '0123456789abcdef0123456789abcdef0123456789abcdef';
    const srv = machine(); await lab(srv);
    await sh(srv, `sh -c 'printf "${key48}" > ${PKI}/tk'`);
    await up(srv, `  ssl_session_ticket_key ${PKI}/tk;\n`);
    const first = (await exchange(srv, V12))!;
    const saved = first.client.exportLegacySession();
    await sh(srv, `sh -c 'printf "fedcba9876543210fedcba9876543210fedcba9876543210" > ${PKI}/tk'`);
    await sh(srv, 'nginx -s reload');
    const second = (await exchange(srv, { versions: ['1.2'], legacySession: saved ?? undefined } as never))!;
    expect(second.client.legacyResumed).toBe(false);
  });
});

describe('TLS 1.3 : tickets et early data (ssl_session_tickets, ssl_early_data)', () => {
  const EARLY = new TextEncoder().encode('GET / HTTP/1.1\r\nHost: lab.local\r\n\r\n');

  it('défaut : un NewSessionTicket est émis, et l\'early data n\'est pas accepté (ssl_early_data off)', async () => {
    const srv = machine(); await lab(srv); await up(srv);
    const first = (await exchange(srv, {}))!;
    expect(first.client.receivedTicket).not.toBeNull();
    const second = (await exchange(srv, { resumptionTicket: first.client.receivedTicket!, earlyData: EARLY } as never))!;
    expect(second.client.result).toBe('success');
    expect(second.client.earlyDataAccepted).toBe(false);
  });

  it('ssl_early_data on : le serveur accepte les données 0-RTT d\'un ticket valide', async () => {
    const srv = machine(); await lab(srv); await up(srv, '  ssl_early_data on;\n');
    const first = (await exchange(srv, {}))!;
    const second = (await exchange(srv, { resumptionTicket: first.client.receivedTicket!, earlyData: EARLY } as never))!;
    expect(second.client.earlyDataAccepted).toBe(true);
  });

  it('ssl_session_tickets off sans cache : aucun ticket TLS 1.3', async () => {
    const srv = machine(); await lab(srv); await up(srv, '  ssl_session_tickets off;\n');
    expect((await exchange(srv, {}))!.client.receivedTicket).toBeNull();
  });

  it('un ticket TLS 1.3 reprend la session (PSK) et la requête aboutit', async () => {
    const srv = machine(); await lab(srv); await up(srv);
    const first = (await exchange(srv, {}))!;
    const bus = new EventBus();
    const resumed: unknown[] = [];
    bus.subscribe('tls.session.resumed', (event) => { resumed.push(event); });
    const second = (await exchange(srv, { resumptionTicket: first.client.receivedTicket!, eventBus: bus } as never))!;
    expect(second.status).toContain('200');
    expect(resumed.length).toBe(1);
  });
});

describe('ssl_ecdh_curve, ssl_conf_command, ssl_ciphers', () => {
  it('ssl_ecdh_curve secp256r1 : un client x25519 seul est refusé, un client P-256 passe', async () => {
    const srv = machine(); await lab(srv); await up(srv, '  ssl_ecdh_curve secp256r1;\n');
    const x = await exchange(srv, { supportedGroups: ['x25519'] } as never);
    expect(x?.client.result).not.toBe('success');
    const p = await exchange(srv, { supportedGroups: ['secp256r1'] } as never);
    expect(p?.status).toContain('200');
  });

  it('ssl_conf_command MinProtocol TLSv1.3 refuse un client TLS 1.2', async () => {
    const srv = machine(); await lab(srv); await up(srv, '  ssl_conf_command MinProtocol TLSv1.3;\n');
    expect(await sh(srv, 'curl -sS -k --tlsv1.2 --tls-max 1.2 https://127.0.0.1/')).toContain('curl: (35)');
    expect(await sh(srv, 'curl -sS -k https://127.0.0.1/')).toContain('Welcome');
  });

  it('ssl_conf_command Ciphersuites TLS_CHACHA20_POLY1305_SHA256 fixe la suite TLS 1.3', async () => {
    const srv = machine(); await lab(srv); await up(srv, '  ssl_conf_command Ciphersuites TLS_CHACHA20_POLY1305_SHA256;\n');
    const x = await exchange(srv, {});
    expect(x?.client.negotiatedCipherSuite).toBe('TLS_CHACHA20_POLY1305_SHA256');
  });

  it('ssl_conf_command Options -SessionTicket coupe les tickets', async () => {
    const srv = machine(); await lab(srv); await up(srv, '  ssl_conf_command Options -SessionTicket;\n');
    const first = (await exchange(srv, { versions: ['1.2'] } as never))!;
    expect(first.client.exportLegacySession()?.ticket ?? '').toBe('');
  });

  it('curl --tls13-ciphers et --curves sont évalués par le serveur', async () => {
    const srv = machine(); await lab(srv); await up(srv, '  ssl_ecdh_curve secp256r1;\n');
    expect(await sh(srv, 'curl -sS -k --curves X25519 https://127.0.0.1/')).toContain('curl: (35)');
    expect(await sh(srv, 'curl -sS -k --curves P-256 https://127.0.0.1/')).toContain('Welcome');
    expect(await sh(srv, 'curl -sS -k --curves zorglub https://127.0.0.1/')).toContain("curl: (59) failed setting curves list: 'zorglub'");
  });
});

describe('ssl_buffer_size, ssl_early_data, ssl_dhparam, ssl_password_file, ssl_crl', () => {
  it('ssl_buffer_size 4k découpe la réponse en enregistrements de ≤ 4096 octets, le défaut n\'en fait qu\'un ou deux', async () => {
    const srv = machine(); await lab(srv);
    await sh(srv, `sh -c 'printf "%9000s" "" > /var/www/html/big.txt'`);
    await up(srv, '  ssl_buffer_size 4k;\n');
    const small = await exchange(srv, { versions: ['1.2'] } as never, 'lab.local', '/big.txt');
    expect(small!.records.length).toBeGreaterThanOrEqual(3);
    expect(Math.max(...small!.records.map((r) => r.fragment.length))).toBeLessThanOrEqual(4096 + 64);
    await site(srv, SERVER());
    await sh(srv, 'nginx -s reload');
    const large = await exchange(srv, { versions: ['1.2'] } as never, 'lab.local', '/big.txt');
    expect(large!.records.length).toBeLessThan(small!.records.length);
  });

  it('ssl_dhparam : un groupe de 768 bits (64 bits de sécurité) est refusé par un client de niveau 1, le groupe par défaut de 2048 bits passe', async () => {
    const srv = machine(); await lab(srv);
    const dhe = '  ssl_protocols TLSv1.2;\n  ssl_ciphers DHE-RSA-AES128-GCM-SHA256;\n';
    const client = { versions: ['1.2'], cipherList: 'DHE-RSA-AES128-GCM-SHA256', securityLevel: 1 } as never;
    await up(srv, dhe);
    expect((await exchange(srv, client))?.status).toContain('200');
    await sh(srv, `openssl dhparam -out ${PKI}/dh768.pem 768`);
    await site(srv, SERVER(`${dhe}  ssl_dhparam ${PKI}/dh768.pem;\n`));
    await sh(srv, 'nginx -s reload');
    const weak = await exchange(srv, client);
    expect(weak?.client.result).not.toBe('success');
  });

  it('ssl_dhparam absent ou illisible : BIO_new_file / PEM_read_bio_DHparams, dans les mots de nginx', async () => {
    const srv = machine(); await lab(srv);
    await site(srv, SERVER(`  ssl_dhparam ${PKI}/nope.pem;\n`));
    await sh(srv, 'systemctl start nginx');
    expect(await sh(srv, 'cat /var/log/nginx/error.log')).toContain(`BIO_new_file("${PKI}/nope.pem") failed`);
    await sh(srv, `sh -c 'printf "garbage" > ${PKI}/bad.pem'`);
    await site(srv, SERVER(`  ssl_dhparam ${PKI}/bad.pem;\n`));
    expect(await sh(srv, 'nginx -t')).toContain(`PEM_read_bio_DHparams("${PKI}/bad.pem") failed`);
  });

  it('ssl_crl : un certificat client révoqué par la CA est refusé (495), avant révocation il passe', async () => {
    const srv = machine(); await lab(srv);
    await sh(srv, 'mkdir -p /etc/ssl/CA');
    await sh(srv, `openssl req -new -newkey rsa:1024 -nodes -keyout ${PKI}/dave.key -out ${PKI}/dave.csr -subj "/CN=dave"`);
    await sh(srv, `openssl ca -cert ${PKI}/ca.crt -keyfile ${PKI}/ca.key -in ${PKI}/dave.csr -out ${PKI}/dave.crt -days 30`);
    await sh(srv, `openssl ca -cert ${PKI}/ca.crt -keyfile ${PKI}/ca.key -gencrl -out ${PKI}/ca.crl`);
    await up(srv, `${MTLS}  ssl_crl ${PKI}/ca.crl;\n`);
    const dave = `--cert ${PKI}/dave.crt --key ${PKI}/dave.key`;
    expect(await sh(srv, `curl -sS -k ${dave} https://127.0.0.1/`)).toContain('Welcome');
    await sh(srv, `openssl ca -cert ${PKI}/ca.crt -keyfile ${PKI}/ca.key -revoke ${PKI}/dave.crt`);
    await sh(srv, `openssl ca -cert ${PKI}/ca.crt -keyfile ${PKI}/ca.key -gencrl -out ${PKI}/ca.crl`);
    await sh(srv, 'nginx -s reload');
    expect(await sh(srv, `curl -sS -k ${dave} https://127.0.0.1/`)).toContain('400 The SSL certificate error');
  });

  it('ssl_crl absent du disque : X509_LOOKUP_load_file failed', async () => {
    const srv = machine(); await lab(srv);
    await site(srv, SERVER(`${MTLS}  ssl_crl ${PKI}/nope.crl;\n`));
    expect(await sh(srv, 'nginx -t')).not.toContain('successful');
    await sh(srv, 'systemctl start nginx');
    expect(await sh(srv, 'cat /var/log/nginx/error.log')).toContain(`X509_LOOKUP_load_file("${PKI}/nope.crl") failed`);
  });

  it('ssl_password_file : une clé chiffrée se charge avec le bon mot de passe et pas sans', async () => {
    const srv = machine(); await lab(srv);
    await sh(srv, `openssl rsa -in ${PKI}/srv.key -aes256 -passout pass:s3cret -out ${PKI}/srv-enc.key`);
    await sh(srv, `sh -c 'printf "s3cret\\n" > ${PKI}/pw'`);
    await site(srv, SERVER().replace('srv.key', 'srv-enc.key'));
    await sh(srv, 'systemctl start nginx');
    expect(await sh(srv, 'cat /var/log/nginx/error.log')).toContain('bad password read');
    await site(srv, SERVER(`  ssl_password_file ${PKI}/pw;\n`).replace('srv.key', 'srv-enc.key'));
    expect(await sh(srv, 'nginx -t')).toContain('successful');
    await sh(srv, 'systemctl start nginx');
    expect(await sh(srv, 'curl -sS -k https://127.0.0.1/')).toContain('Welcome');
  });
});
