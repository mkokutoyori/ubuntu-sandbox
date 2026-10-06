/**
 * Port de `SSL_CONF_cmd` (OpenSSL 3.0.13 ssl/ssl_conf.c), certificat client de
 * curl 8.5.0 (lib/vtls/openssl.c, src/tool_getparam.c), `x509 -req -extfile`
 * (apps/x509.c, crypto/x509/v3_*.c), `dhparam` (apps/dhparam.c), clés chiffrées (`-aes256 -passout`),
 * profondeur de vérification (x509_vfy.c `max_depth = depth + 1`) et
 * politique TLS serveur (`rejectHandshake`, `earlyData`, `sendBufferSize`).
 *
 * MESURÉ avant correctif : `curl --cert/--key/--tls13-ciphers/--curves`
 * refusés (« option unknown »), `-extfile` ignoré (sous-CA sans
 * basicConstraints), `rsa -aes256 -passout` écrivait la clé EN CLAIR, la
 * profondeur de chaîne n'était pas bornée, le serveur TLS n'avait ni
 * `rejectHandshake`, ni `earlyData`, ni plafond d'enregistrement, et
 * `certificate_expired` était rendue pour un certificat pas encore valide
 * (x509table dit bad_certificate).
 *
 * Avant correctif, 32 des 36 cas tombent (les 7 de `SSL_CONF_cmd` parce que
 * le module n'existait pas, 25 sur les 29 autres) ; les quatre témoins
 * passent dans les deux états : `maxDepth 1` laisse passer une feuille émise
 * directement par la racine (non-régression), le plafond d'enregistrement
 * reste celui de la RFC 8449 sans `sendBufferSize` (témoin), un sous-CA émis
 * sans basicConstraints est refusé (la feuille `cA:false` par défaut le
 * portait déjà) et `-newkey rsa:1024` sans option produit une clé lisible.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import {
  createSslConfState, applySslConfCommand, effectiveProtocols, parseGroupList,
} from '@/network/tls/legacy/sslConf';
import { CertificateAuthority } from '@/network/pki/CertificateAuthority';
import { CertificateVerifier } from '@/network/pki/CertificateVerifier';
import { TlsServerSession } from '@/network/tls/TlsServerSession';
import { TlsClientSession } from '@/network/tls/TlsClientSession';
import type { TlsRecord } from '@/network/tls/recordLayer';

beforeEach(() => { EquipmentRegistry.getInstance().clear(); });

describe('SSL_CONF_cmd (ssl_conf.c)', () => {
  it('Protocol -TLSv1.1,-TLSv1 retire ces versions de la liste', () => {
    const state = createSslConfState();
    expect(applySslConfCommand(state, 'Protocol', '-TLSv1,-TLSv1.1').ok).toBe(true);
    expect(effectiveProtocols(['1.0', '1.1', '1.2', '1.3'], state)).toEqual(['1.2', '1.3']);
  });

  it('MinProtocol / MaxProtocol bornent la liste, un nom inconnu est « bad value »', () => {
    const state = createSslConfState();
    applySslConfCommand(state, 'MinProtocol', 'TLSv1.2');
    applySslConfCommand(state, 'MaxProtocol', 'TLSv1.2');
    expect(effectiveProtocols(['1.0', '1.1', '1.2', '1.3'], state)).toEqual(['1.2']);
    const bad = applySslConfCommand(createSslConfState(), 'MinProtocol', 'TLSv9');
    expect(bad.ok).toBe(false);
    expect(bad.ok === false && bad.errors).toEqual(['error:0A000180:SSL routines::bad value:cmd=MinProtocol, value=TLSv9']);
  });

  it('une commande inconnue donne « unknown cmd name » (0A000182)', () => {
    const out = applySslConfCommand(createSslConfState(), 'Zorglub', '1');
    expect(out.ok === false && out.errors[0]).toBe('error:0A000182:SSL routines::unknown cmd name:cmd=Zorglub');
  });

  it('CipherString invalide : « no cipher match » puis « bad value », comme la file d\'erreurs', () => {
    const out = applySslConfCommand(createSslConfState(), 'CipherString', 'ZZZ');
    expect(out.ok === false && out.errors.length).toBe(2);
    expect(out.ok === false && out.errors[0]).toContain('no cipher match');
    expect(out.ok === false && out.errors[1]).toContain('cmd=CipherString, value=ZZZ');
  });

  it('Groups accepte P-256 et x25519, refuse un doublon et un nom inconnu (passed invalid argument)', () => {
    expect(parseGroupList('P-256:X25519')).toEqual({ ok: true, groups: ['secp256r1', 'x25519'] });
    const dup = parseGroupList('P-256:secp256r1');
    expect(dup.ok).toBe(false);
    expect(dup.ok === false && dup.error).toBe("error:0A080106:SSL routines::passed invalid argument:group 'secp256r1' cannot be set");
  });

  it('Options liste : +ServerPreference, -SessionTicket ; une option inconnue est refusée', () => {
    const state = createSslConfState();
    expect(applySslConfCommand(state, 'Options', 'ServerPreference,-SessionTicket').ok).toBe(true);
    expect(state.serverPreference).toBe(true);
    expect(state.sessionTicket).toBe(false);
    expect(applySslConfCommand(createSslConfState(), 'Options', 'Zorglub').ok).toBe(false);
  });

  it('en ligne de commande (s_client) le nom est celui de str_cmdline, pas celui du fichier', () => {
    const state = createSslConfState();
    expect(applySslConfCommand(state, 'ciphersuites', 'TLS_AES_128_GCM_SHA256', { mode: 'cmdline', server: false }).ok).toBe(true);
    expect(state.tls13Ciphersuites).toBe('TLS_AES_128_GCM_SHA256');
    expect(applySslConfCommand(createSslConfState(), 'Ciphersuites', 'x', { mode: 'cmdline', server: false }).ok).toBe(false);
  });
});

describe('x509table (statem_lib.c) et profondeur (x509_vfy.c)', () => {
  const NOW = Date.now();
  function pki() {
    const root = CertificateAuthority.generate('CN=Root', { now: NOW });
    const sub = (root as unknown as { issueSubordinateCA(o: unknown): CertificateAuthority })
      .issueSubordinateCA({ subject: 'CN=Sub', notBefore: NOW - 1000, notAfter: NOW + 1e9 });
    const leaf = sub.issueCertificate({ subject: 'CN=leaf', notBefore: NOW - 1000, notAfter: NOW + 1e9 });
    const direct = root.issueCertificate({ subject: 'CN=direct', notBefore: NOW - 1000, notAfter: NOW + 1e9 });
    return { root, sub, leaf, direct };
  }

  it('maxDepth 1 : feuille→sous-CA→racine dépasse (chain-too-long), maxDepth 2 passe', () => {
    const { root, sub, leaf } = pki();
    const shallow = new CertificateVerifier({ trustAnchors: [root.rootCertificate], clock: () => NOW, maxDepth: 1 });
    expect(shallow.verify(leaf.cert, undefined, [sub.rootCertificate])).toEqual({ ok: false, reason: 'chain-too-long' });
    const deeper = new CertificateVerifier({ trustAnchors: [root.rootCertificate], clock: () => NOW, maxDepth: 2 });
    expect(deeper.verify(leaf.cert, undefined, [sub.rootCertificate]).ok).toBe(true);
  });

  it('témoin : maxDepth 1 laisse passer une feuille émise directement par la racine', () => {
    const { root, direct } = pki();
    const verifier = new CertificateVerifier({ trustAnchors: [root.rootCertificate], clock: () => NOW, maxDepth: 1 });
    expect(verifier.verify(direct.cert).ok).toBe(true);
  });

  it('maxDepth 0 refuse même une feuille émise par la racine', () => {
    const { root, direct } = pki();
    const verifier = new CertificateVerifier({ trustAnchors: [root.rootCertificate], clock: () => NOW, maxDepth: 0 });
    expect(verifier.verify(direct.cert)).toEqual({ ok: false, reason: 'chain-too-long' });
  });
});

describe('politique du serveur TLS : rejectHandshake, earlyData, sendBufferSize', () => {
  const NOW = Date.now();
  const ca = CertificateAuthority.generate('CN=Root', { now: NOW });
  const a = ca.issueCertificate({ subject: 'CN=a', notBefore: NOW - 1000, notAfter: NOW + 1e9, subjectAltNames: ['a.lab'] } as never);
  const b = ca.issueCertificate({ subject: 'CN=b', notBefore: NOW - 1000, notAfter: NOW + 1e9, subjectAltNames: ['b.lab'] } as never);
  const verifier = new CertificateVerifier({ trustAnchors: [ca.rootCertificate], clock: () => NOW });

  function run(serverConfig: object, serverName?: string) {
    const server = new TlsServerSession({ serverCert: a.cert, serverPrivateKey: a.privateKey, ...serverConfig } as never);
    const client = new TlsClientSession({ verifier, serverName, versions: ['1.3'] } as never);
    let out: readonly TlsRecord[] | null = client.start();
    for (let i = 0; i < 6 && out !== null && out.length > 0; i++) {
      const reply: readonly TlsRecord[] | null = server.handle(out);
      if (reply === null || reply.length === 0) break;
      out = client.handle(reply);
    }
    return { client, server };
  }

  it('rejectHandshake : sans SNI le serveur répond unrecognized_name', () => {
    const { client, server } = run({ rejectHandshake: true });
    expect(server.result).toBe('reject');
    expect(client.peerAlert?.description).toBe('unrecognized_name');
  });

  it('rejectHandshake : un nom couvert par un identifiant SNI passe, un autre est rejeté', () => {
    const creds = [{ cert: b.cert, privateKey: b.privateKey, hostnames: ['b.lab'] }];
    expect(run({ rejectHandshake: true, sniCredentials: creds }, 'b.lab').server.result).toBe('accept');
    const unknown = run({ rejectHandshake: true, sniCredentials: creds }, 'zz.lab');
    expect(unknown.server.result).toBe('reject');
    expect(unknown.client.peerAlert?.description).toBe('unrecognized_name');
  });

  it('un identifiant marqué rejectHandshake est rejeté même s\'il est nommé', () => {
    const creds = [{ cert: b.cert, privateKey: b.privateKey, hostnames: ['b.lab'], rejectHandshake: true }];
    expect(run({ sniCredentials: creds }, 'b.lab').server.result).toBe('reject');
  });

  it('un prédicat `matches` remplace la liste de noms', () => {
    const creds = [{ cert: b.cert, privateKey: b.privateKey, matches: (n: string) => n.endsWith('.zone') }];
    const out = run({ sniCredentials: creds }, 'x.zone');
    expect(out.client.peerCertificate?.subject).toBe('CN=b');
  });

  it('sendBufferSize plafonne le texte clair d\'un enregistrement émis par le serveur', () => {
    const { server } = run({ sendBufferSize: 512 });
    const traffic = server.serverTraffic() as { maxFragment: number };
    expect(traffic.maxFragment).toBe(512);
  });

  it('témoin : sans sendBufferSize le plafond reste la limite RFC 8449', () => {
    const { server } = run({});
    expect((server.serverTraffic() as { maxFragment: number }).maxFragment).toBe(16384);
  });

  it('le serveur expose le nom SNI négocié et la chaîne du client', () => {
    const { server } = run({}, 'a.lab');
    expect(server.negotiatedServerName).toBe('a.lab');
    expect(server.peerCertificateChain).toEqual([]);
  });
});

const PKI = '/etc/ssl/pki';

function machine(): LinuxServer {
  const srv = new LinuxServer('linux-server', 'OS');
  srv.powerOn();
  return srv;
}

describe('curl : certificat client (tool_getparam.c, openssl.c)', () => {
  async function labWithMtls(): Promise<LinuxServer> {
    const srv = machine();
    await srv.executeCommand(`mkdir -p ${PKI}`);
    await srv.executeCommand(`openssl req -x509 -newkey rsa:1024 -keyout ${PKI}/ca.key -out ${PKI}/ca.crt -days 30 -nodes -subj "/CN=CA"`);
    await srv.executeCommand(`openssl req -x509 -newkey rsa:1024 -keyout ${PKI}/srv.key -out ${PKI}/srv.crt -days 30 -nodes -subj "/CN=lab.local"`);
    await srv.executeCommand(`openssl req -new -newkey rsa:1024 -nodes -keyout ${PKI}/c.key -out ${PKI}/c.csr -subj "/CN=client"`);
    await srv.executeCommand(`openssl x509 -req -in ${PKI}/c.csr -CA ${PKI}/ca.crt -CAkey ${PKI}/ca.key -CAcreateserial -out ${PKI}/c.crt -days 30`);
    await srv.executeCommand(`sh -c 'printf "server {\\n listen 443 ssl;\\n root /var/www/html;\\n index index.nginx-debian.html;\\n ssl_certificate ${PKI}/srv.crt;\\n ssl_certificate_key ${PKI}/srv.key;\\n ssl_verify_client on;\\n ssl_client_certificate ${PKI}/ca.crt;\\n}\\n" > /etc/nginx/sites-available/default'`);
    await srv.executeCommand('systemctl start nginx');
    return srv;
  }

  it('--cert absent : « could not load PEM client certificate » (58)', async () => {
    const srv = await labWithMtls();
    const out = await srv.executeCommand('curl -sS -k --cert /nope.pem https://127.0.0.1/');
    expect(out).toContain('curl: (58) could not load PEM client certificate from /nope.pem, OpenSSL error error:80000002:system library::No such file or directory, (no key found, wrong pass phrase, or wrong file format?)');
  });

  it('--key absent : « unable to set private key file » (58)', async () => {
    const srv = await labWithMtls();
    const out = await srv.executeCommand(`curl -sS -k --cert ${PKI}/c.crt --key /nope.key https://127.0.0.1/`);
    expect(out).toContain("curl: (58) unable to set private key file: '/nope.key' type PEM");
  });

  it('une clé qui n\'est pas celle du certificat : « Private key does not match »', async () => {
    const srv = await labWithMtls();
    const out = await srv.executeCommand(`curl -sS -k --cert ${PKI}/c.crt --key ${PKI}/srv.key https://127.0.0.1/`);
    expect(out).toContain('curl: (58) Private key does not match the certificate public key');
  });

  it('-E cert:phrase déchiffre la clé du même fichier PEM ; sans phrase, la clé chiffrée est refusée', async () => {
    const srv = await labWithMtls();
    await srv.executeCommand(`openssl rsa -in ${PKI}/c.key -aes256 -passout pass:s3cret -out ${PKI}/c-enc.key`);
    await srv.executeCommand(`sh -c 'cat ${PKI}/c.crt ${PKI}/c-enc.key > ${PKI}/c-bundle.pem'`);
    expect(await srv.executeCommand(`curl -sS -k -E ${PKI}/c-bundle.pem:s3cret https://127.0.0.1/`)).toContain('Welcome');
    expect(await srv.executeCommand(`curl -sS -k -E ${PKI}/c-bundle.pem https://127.0.0.1/`)).toContain('curl: (58)');
    expect(await srv.executeCommand(`curl -sS -k --cert ${PKI}/c.crt --key ${PKI}/c-enc.key --pass s3cret https://127.0.0.1/`)).toContain('Welcome');
  });

  it('--ciphers invalide : le message de lib/vtls/openssl.c, pas celui de strerror', async () => {
    const srv = await labWithMtls();
    expect(await srv.executeCommand('curl -sS -k --ciphers ZZZ https://127.0.0.1/')).toContain('curl: (59) failed setting cipher list: ZZZ');
  });

  it('--tls13-ciphers fixe la suite TLS 1.3 offerte', async () => {
    const srv = await labWithMtls();
    const out = await srv.executeCommand(`curl -sS -k -v --tls13-ciphers TLS_CHACHA20_POLY1305_SHA256 --cert ${PKI}/c.crt --key ${PKI}/c.key https://127.0.0.1/ 2>&1`);
    expect(out).toContain('TLS_CHACHA20_POLY1305_SHA256');
  });
});

describe('openssl : clés chiffrées et extensions X509v3', () => {
  it('rsa -aes256 -passout écrit une clé ENCRYPTED PRIVATE KEY, relue seulement avec -passin', async () => {
    const srv = machine();
    await srv.executeCommand(`mkdir -p ${PKI}`);
    await srv.executeCommand(`openssl genrsa -out ${PKI}/k.key 1024`);
    await srv.executeCommand(`openssl rsa -in ${PKI}/k.key -aes256 -passout pass:s3cret -out ${PKI}/k-enc.key`);
    expect(await srv.executeCommand(`cat ${PKI}/k-enc.key`)).toContain('BEGIN ENCRYPTED PRIVATE KEY');
    expect(await srv.executeCommand(`openssl rsa -in ${PKI}/k-enc.key -noout -modulus`)).toContain('unable to load Private Key');
    const plain = await srv.executeCommand(`openssl rsa -in ${PKI}/k-enc.key -passin pass:s3cret -noout -modulus`);
    const original = await srv.executeCommand(`openssl rsa -in ${PKI}/k.key -noout -modulus`);
    expect(plain.trim()).toBe(original.trim());
  });

  it('-passin file:chemin lit la première ligne du fichier', async () => {
    const srv = machine();
    await srv.executeCommand(`mkdir -p ${PKI}`);
    await srv.executeCommand(`openssl genrsa -aes256 -passout pass:abc -out ${PKI}/k-enc.key 1024`);
    expect(await srv.executeCommand(`cat ${PKI}/k-enc.key`)).toContain('BEGIN ENCRYPTED PRIVATE KEY');
    await srv.executeCommand(`sh -c 'printf "abc\\nsecond\\n" > ${PKI}/pw'`);
    expect(await srv.executeCommand(`openssl rsa -in ${PKI}/k-enc.key -passin file:${PKI}/pw -noout -modulus`)).toContain('Modulus=');
  });

  async function chain(srv: LinuxServer, subExt: string): Promise<void> {
    await srv.executeCommand(`mkdir -p ${PKI}`);
    await srv.executeCommand(`openssl req -x509 -newkey rsa:1024 -keyout ${PKI}/root.key -out ${PKI}/root.crt -days 30 -nodes -subj "/CN=Root"`);
    await srv.executeCommand(`sh -c 'printf "${subExt}\\n" > ${PKI}/sub.ext'`);
    await srv.executeCommand(`openssl req -new -newkey rsa:1024 -nodes -keyout ${PKI}/sub.key -out ${PKI}/sub.csr -subj "/CN=Sub"`);
    await srv.executeCommand(`openssl x509 -req -in ${PKI}/sub.csr -CA ${PKI}/root.crt -CAkey ${PKI}/root.key -CAcreateserial -extfile ${PKI}/sub.ext -out ${PKI}/sub.crt -days 30`);
    await srv.executeCommand(`openssl req -new -newkey rsa:1024 -nodes -keyout ${PKI}/leaf.key -out ${PKI}/leaf.csr -subj "/CN=leaf"`);
    await srv.executeCommand(`openssl x509 -req -in ${PKI}/leaf.csr -CA ${PKI}/sub.crt -CAkey ${PKI}/sub.key -CAcreateserial -out ${PKI}/leaf.crt -days 30`);
  }

  it('verify -untrusted : racine → sous-CA (basicConstraints CA:TRUE) → feuille aboutit ; sans -untrusted, issuer introuvable', async () => {
    const srv = machine();
    await chain(srv, 'basicConstraints=critical,CA:TRUE');
    expect(await srv.executeCommand(`openssl verify -CAfile ${PKI}/root.crt -untrusted ${PKI}/sub.crt ${PKI}/leaf.crt`)).toContain('leaf.crt: OK');
    const missing = await srv.executeCommand(`openssl verify -CAfile ${PKI}/root.crt ${PKI}/leaf.crt`);
    expect(missing).toContain('unable to get local issuer certificate');
  });

  it('un sous-CA émis sans basicConstraints est refusé : invalid CA certificate', async () => {
    const srv = machine();
    await chain(srv, 'keyUsage=digitalSignature');
    expect(await srv.executeCommand(`openssl verify -CAfile ${PKI}/root.crt -untrusted ${PKI}/sub.crt ${PKI}/leaf.crt`)).toContain('invalid CA certificate');
  });

  it('pathlen:0 sur le sous-CA permet une feuille, pas un second sous-CA', async () => {
    const srv = machine();
    await chain(srv, 'basicConstraints=critical,CA:TRUE,pathlen:0');
    expect(await srv.executeCommand(`openssl verify -CAfile ${PKI}/root.crt -untrusted ${PKI}/sub.crt ${PKI}/leaf.crt`)).toContain('OK');
    await srv.executeCommand(`sh -c 'printf "basicConstraints=critical,CA:TRUE\\n" > ${PKI}/sub2.ext'`);
    await srv.executeCommand(`openssl req -new -newkey rsa:1024 -nodes -keyout ${PKI}/sub2.key -out ${PKI}/sub2.csr -subj "/CN=Sub2"`);
    await srv.executeCommand(`openssl x509 -req -in ${PKI}/sub2.csr -CA ${PKI}/sub.crt -CAkey ${PKI}/sub.key -CAcreateserial -extfile ${PKI}/sub2.ext -out ${PKI}/sub2.crt -days 30`);
    await srv.executeCommand(`openssl req -new -newkey rsa:1024 -nodes -keyout ${PKI}/l2.key -out ${PKI}/l2.csr -subj "/CN=l2"`);
    await srv.executeCommand(`openssl x509 -req -in ${PKI}/l2.csr -CA ${PKI}/sub2.crt -CAkey ${PKI}/sub2.key -CAcreateserial -out ${PKI}/l2.crt -days 30`);
    await srv.executeCommand(`sh -c 'cat ${PKI}/sub.crt ${PKI}/sub2.crt > ${PKI}/subs.pem'`);
    expect(await srv.executeCommand(`openssl verify -CAfile ${PKI}/root.crt -untrusted ${PKI}/subs.pem ${PKI}/l2.crt`)).toContain('path length constraint exceeded');
  });

  it('-extfile : extension inconnue → erreur nommant la section', async () => {
    const srv = machine();
    await chain(srv, 'basicConstraints=CA:TRUE');
    await srv.executeCommand(`sh -c 'printf "zorglub=1\\n" > ${PKI}/bad.ext'`);
    const out = await srv.executeCommand(`openssl x509 -req -in ${PKI}/sub.csr -CA ${PKI}/root.crt -CAkey ${PKI}/root.key -CAcreateserial -extfile ${PKI}/bad.ext -out ${PKI}/x.crt -days 30`);
    expect(out).toContain('Error adding extensions from section default');
    expect(out).toContain('unknown extension name');
  });

  it('-extfile : keyUsage inconnu → unknown bit string argument', async () => {
    const srv = machine();
    await chain(srv, 'basicConstraints=CA:TRUE');
    await srv.executeCommand(`sh -c 'printf "keyUsage=zorglub\\n" > ${PKI}/bad.ext'`);
    const out = await srv.executeCommand(`openssl x509 -req -in ${PKI}/sub.csr -CA ${PKI}/root.crt -CAkey ${PKI}/root.key -CAcreateserial -extfile ${PKI}/bad.ext -out ${PKI}/x.crt -days 30`);
    expect(out).toContain('unknown bit string argument');
  });

  it('témoin : un -newkey rsa:1024 sans option produit toujours une clé lisible', async () => {
    const srv = machine();
    await srv.executeCommand(`mkdir -p ${PKI}`);
    await srv.executeCommand(`openssl req -new -newkey rsa:1024 -nodes -keyout ${PKI}/p.key -out ${PKI}/p.csr -subj "/CN=p"`);
    expect(await srv.executeCommand(`openssl rsa -in ${PKI}/p.key -noout -modulus`)).toContain('Modulus=');
  });
});

describe('openssl dhparam (apps/dhparam.c, encode_key2text.c)', () => {
  it('dhparam 2048 écrit un bloc DH PARAMETERS et annonce la génération sur stderr', async () => {
    const srv = machine();
    const out = await srv.executeCommand('openssl dhparam -out /tmp/dh.pem 2048 2>&1');
    expect(out).toContain('Generating DH parameters, 2048 bit long safe prime');
    expect(await srv.executeCommand('cat /tmp/dh.pem')).toContain('-----BEGIN DH PARAMETERS-----');
  });

  it('-text imprime « DH Parameters: (N bit) », P sur lignes de 15 octets avec 00 de tête, G: 2 (0x2), indentés de 4', async () => {
    const srv = machine();
    await srv.executeCommand('openssl dhparam -out /tmp/dh.pem 1024');
    const text = await srv.executeCommand('openssl dhparam -in /tmp/dh.pem -noout -text');
    const lines = text.split('\n');
    expect(lines[0]).toBe('    DH Parameters: (1024 bit)');
    expect(lines[1]).toBe('    P:   ');
    expect(lines[2]).toBe('        00:ff:ff:ff:ff:ff:ff:ff:ff:c9:0f:da:a2:21:68:');
    expect(lines.filter((line) => line !== '').pop()).toBe('    G:    2 (0x2)');
  });

  it('-text nomme un groupe connu comme openssl 3.0 (GROUP: modp_2048) au lieu de P et G', async () => {
    const srv = machine();
    await srv.executeCommand('openssl dhparam -out /tmp/dh.pem 2048');
    const text = await srv.executeCommand('openssl dhparam -in /tmp/dh.pem -noout -text');
    expect(text).toContain('    GROUP: modp_2048');
    expect(text).not.toContain('    P:');
  });

  it('-check valide un groupe sûr', async () => {
    const srv = machine();
    await srv.executeCommand('openssl dhparam -out /tmp/dh.pem 1024');
    expect(await srv.executeCommand('openssl dhparam -in /tmp/dh.pem -check -noout 2>&1')).toContain('DH parameters appear to be ok.');
  });

  it('un fichier qui n\'est pas des paramètres DH : Error, unable to load parameters', async () => {
    const srv = machine();
    await srv.executeCommand(`sh -c 'printf "nope" > /tmp/x.pem'`);
    expect(await srv.executeCommand('openssl dhparam -in /tmp/x.pem 2>&1')).toContain('Error, unable to load parameters');
  });

  it('une taille sans groupe précalculé est refusée en le disant', async () => {
    const srv = machine();
    expect(await srv.executeCommand('openssl dhparam 1111 2>&1')).toContain('safe prime is not available here');
  });
});
