/**
 * `openssl ocsp` (OpenSSL 3.0.13 apps/ocsp.c) : requête, répondeur local,
 * répondeur HTTP sur le fil (`-port`), client `-url`, vérification de la
 * réponse, nonce, états good/revoked/unknown.
 *
 * MESURÉ avant correctif : `openssl ocsp` répondait « is not implemented in
 * this simulator » ; aucun répondeur OCSP ne pouvait être interrogé par
 * deux machines, et `ssl_stapling_file` ne lisait qu'une réponse à un seul
 * certificat. Avant correctif, 11 des 12 cas tombent ; le témoin (un
 * certificat émis par `openssl ca` est bien dans l'index) passe dans les
 * deux états.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import { Cable } from '@/network/hardware/Cable';
import { IPAddress, SubnetMask } from '@/network/core/types';

beforeEach(() => { EquipmentRegistry.getInstance().clear(); });

const CA = '/etc/ssl/CA';

async function pki(srv: LinuxServer): Promise<void> {
  await srv.executeCommand(`mkdir -p ${CA}`);
  await srv.executeCommand(`openssl req -x509 -newkey rsa:1024 -keyout ${CA}/ca.key -out ${CA}/ca.crt -days 365 -nodes -subj "/CN=Lab CA"`);
  for (const name of ['good', 'bad']) {
    await srv.executeCommand(`openssl req -new -newkey rsa:1024 -nodes -keyout /tmp/${name}.key -out /tmp/${name}.csr -subj "/CN=${name}.lab"`);
    await srv.executeCommand(`openssl ca -cert ${CA}/ca.crt -keyfile ${CA}/ca.key -in /tmp/${name}.csr -out /tmp/${name}.crt -days 30`);
  }
  await srv.executeCommand(`openssl ca -cert ${CA}/ca.crt -keyfile ${CA}/ca.key -revoke /tmp/bad.crt`);
}

const ISSUER = `-issuer ${CA}/ca.crt`;
const RESPONDER = `-index ${CA}/index.txt -CA ${CA}/ca.crt -rkey ${CA}/ca.key`;

describe('répondeur local (-reqin / -index / -respout) et vérification (-respin)', () => {
  it('témoin : le certificat émis par `openssl ca` est dans l\'index', async () => {
    const srv = new LinuxServer('linux-server', 'O1'); srv.powerOn(); await pki(srv);
    expect(await srv.executeCommand(`cat ${CA}/index.txt`)).toContain('/CN=good.lab');
  });

  it('good : requête, réponse signée, « Response verify OK », « good », This Update / Next Update', async () => {
    const srv = new LinuxServer('linux-server', 'O2'); srv.powerOn(); await pki(srv);
    await srv.executeCommand(`openssl ocsp ${ISSUER} -cert /tmp/good.crt -reqout /tmp/q.req`);
    await srv.executeCommand(`openssl ocsp -reqin /tmp/q.req ${RESPONDER} -respout /tmp/r.resp`);
    const out = await srv.executeCommand(`openssl ocsp ${ISSUER} -cert /tmp/good.crt -respin /tmp/r.resp -CAfile ${CA}/ca.crt 2>&1`);
    expect(out).toContain('Response verify OK');
    expect(out).toContain('/tmp/good.crt: good');
    expect(out).toMatch(/\tThis Update: \w{3} [ \d]\d \d\d:\d\d:\d\d \d{4} GMT/);
    expect(out).toMatch(/\tNext Update: /);
  });

  it('revoked : « revoked » avec Revocation Time', async () => {
    const srv = new LinuxServer('linux-server', 'O3'); srv.powerOn(); await pki(srv);
    await srv.executeCommand(`openssl ocsp ${ISSUER} -cert /tmp/bad.crt -reqout /tmp/q.req`);
    await srv.executeCommand(`openssl ocsp -reqin /tmp/q.req ${RESPONDER} -respout /tmp/r.resp`);
    const out = await srv.executeCommand(`openssl ocsp ${ISSUER} -cert /tmp/bad.crt -respin /tmp/r.resp -CAfile ${CA}/ca.crt 2>&1`);
    expect(out).toContain('/tmp/bad.crt: revoked');
    expect(out).toContain('\tRevocation Time: ');
  });

  it('unknown : un numéro de série absent de l\'index', async () => {
    const srv = new LinuxServer('linux-server', 'O4'); srv.powerOn(); await pki(srv);
    await srv.executeCommand(`openssl ocsp ${ISSUER} -serial 0xDEADBEEF -reqout /tmp/q.req`);
    await srv.executeCommand(`openssl ocsp -reqin /tmp/q.req ${RESPONDER} -respout /tmp/r.resp`);
    expect(await srv.executeCommand(`openssl ocsp ${ISSUER} -serial 0xDEADBEEF -respin /tmp/r.resp -CAfile ${CA}/ca.crt 2>&1`)).toContain('0xDEADBEEF: unknown');
  });

  it('une réponse signée par une autre clé : Response Verify Failure', async () => {
    const srv = new LinuxServer('linux-server', 'O5'); srv.powerOn(); await pki(srv);
    await srv.executeCommand('openssl req -x509 -newkey rsa:1024 -keyout /tmp/other.key -out /tmp/other.crt -days 30 -nodes -subj "/CN=Other"');
    await srv.executeCommand(`openssl ocsp ${ISSUER} -cert /tmp/good.crt -reqout /tmp/q.req`);
    await srv.executeCommand(`openssl ocsp -reqin /tmp/q.req -index ${CA}/index.txt -CA ${CA}/ca.crt -rsigner /tmp/other.crt -rkey /tmp/other.key -respout /tmp/r.resp`);
    const out = await srv.executeCommand(`openssl ocsp ${ISSUER} -cert /tmp/good.crt -respin /tmp/r.resp -CAfile ${CA}/ca.crt 2>&1`);
    expect(out).toContain('Response Verify Failure');
  });

  it('-noverify saute la vérification ; -text imprime la réponse', async () => {
    const srv = new LinuxServer('linux-server', 'O6'); srv.powerOn(); await pki(srv);
    await srv.executeCommand(`openssl ocsp ${ISSUER} -cert /tmp/good.crt -reqout /tmp/q.req`);
    await srv.executeCommand(`openssl ocsp -reqin /tmp/q.req ${RESPONDER} -respout /tmp/r.resp`);
    const out = await srv.executeCommand(`openssl ocsp ${ISSUER} -cert /tmp/good.crt -respin /tmp/r.resp -noverify -text 2>&1`);
    expect(out).not.toContain('Response verify OK');
    expect(out).toContain('OCSP Response Status: successful (0x0)');
    expect(out).toContain('Cert Status: good');
  });

  it('un -issuer absent : « No issuer certificate specified »', async () => {
    const srv = new LinuxServer('linux-server', 'O7'); srv.powerOn(); await pki(srv);
    expect(await srv.executeCommand('openssl ocsp -cert /tmp/good.crt 2>&1')).toContain('No issuer certificate specified');
  });
});

describe('répondeur HTTP sur le fil (-port) et client (-url)', () => {
  function lab(): { responder: LinuxServer; client: LinuxServer } {
    const responder = new LinuxServer('linux-server', 'OR'); responder.powerOn();
    const client = new LinuxServer('linux-server', 'OC'); client.powerOn();
    new Cable('c').connect(responder.getPorts()[0], client.getPorts()[0]);
    responder.configureInterface('eth0', new IPAddress('10.0.0.1'), new SubnetMask('255.255.255.0'));
    client.configureInterface('eth0', new IPAddress('10.0.0.2'), new SubnetMask('255.255.255.0'));
    return { responder, client };
  }

  it('deux machines : le client interroge le répondeur par TCP et lit « good » puis « revoked »', async () => {
    const { responder, client } = lab(); await pki(responder);
    const start = await responder.executeCommand(`openssl ocsp ${RESPONDER} -port 2560 &`);
    expect(start).toBeDefined();
    expect(await responder.executeCommand('ss -ltn')).toMatch(/:2560\s/);
    for (const name of ['good', 'bad']) {
      await client.executeCommand(`mkdir -p ${CA}`);
      await client.executeCommand(`sh -c 'cat > ${CA}/ca.crt' < /dev/null`);
    }
    const crt = await responder.executeCommand(`cat ${CA}/ca.crt`);
    const good = await responder.executeCommand('cat /tmp/good.crt');
    const bad = await responder.executeCommand('cat /tmp/bad.crt');
    await client.executeCommand(`sh -c 'printf "${crt.replace(/\n/g, '\\n')}" > ${CA}/ca.crt'`);
    await client.executeCommand(`sh -c 'printf "${good.replace(/\n/g, '\\n')}" > /tmp/good.crt'`);
    await client.executeCommand(`sh -c 'printf "${bad.replace(/\n/g, '\\n')}" > /tmp/bad.crt'`);
    const a = await client.executeCommand(`openssl ocsp ${ISSUER} -cert /tmp/good.crt -url http://10.0.0.1:2560 -CAfile ${CA}/ca.crt 2>&1`);
    expect(a).toContain('Response verify OK');
    expect(a).toContain('/tmp/good.crt: good');
    const b = await client.executeCommand(`openssl ocsp ${ISSUER} -cert /tmp/bad.crt -url http://10.0.0.1:2560/ -CAfile ${CA}/ca.crt 2>&1`);
    expect(b).toContain('/tmp/bad.crt: revoked');
  });

  it('le nonce est renvoyé : une requête -no_nonce passe sans avertissement de nonce, avec nonce la réponse l\'écho', async () => {
    const { responder, client } = lab(); await pki(responder);
    await responder.executeCommand(`openssl ocsp ${RESPONDER} -port 2560 &`);
    const crt = await responder.executeCommand(`cat ${CA}/ca.crt`);
    const good = await responder.executeCommand('cat /tmp/good.crt');
    await client.executeCommand(`mkdir -p ${CA}`);
    await client.executeCommand(`sh -c 'printf "${crt.replace(/\n/g, '\\n')}" > ${CA}/ca.crt'`);
    await client.executeCommand(`sh -c 'printf "${good.replace(/\n/g, '\\n')}" > /tmp/good.crt'`);
    const out = await client.executeCommand(`openssl ocsp ${ISSUER} -cert /tmp/good.crt -url http://10.0.0.1:2560 -CAfile ${CA}/ca.crt 2>&1`);
    expect(out).not.toContain('Nonce Verify error');
    expect(out).not.toContain('WARNING: no nonce in response');
  });

  it('un répondeur injoignable : « Error querying OCSP responder »', async () => {
    const { responder, client } = lab(); await pki(client);
    expect(await client.executeCommand(`openssl ocsp ${ISSUER} -cert /tmp/good.crt -url http://10.0.0.1:2560 -CAfile ${CA}/ca.crt 2>&1`)).toContain('Error querying OCSP responder');
    void responder;
  });
});

import { CertificateVerifier } from '@/network/pki/CertificateVerifier';
import { pemToCert } from '@/network/pki/pem';
import { TlsClientSession } from '@/network/tls/TlsClientSession';
import { runTlsHandshakeOverSocket } from '@/network/http/https/TlsRecordWire';

describe('réponse agrafée par nginx (ssl_stapling_file) produite par openssl ocsp', () => {
  async function stapledHandshake(name: 'good' | 'bad'): Promise<TlsClientSession> {
    const srv = new LinuxServer('linux-server', 'OS'); srv.powerOn(); await pki(srv);
    await srv.executeCommand(`openssl ocsp ${ISSUER} -cert /tmp/${name}.crt -reqout /tmp/q.req`);
    await srv.executeCommand(`openssl ocsp -reqin /tmp/q.req ${RESPONDER} -respout /tmp/r.resp`);
    await srv.executeCommand(`sh -c 'printf "server {\\n listen 443 ssl;\\n root /var/www/html;\\n ssl_certificate /tmp/${name}.crt;\\n ssl_certificate_key /tmp/${name}.key;\\n ssl_stapling on;\\n ssl_stapling_file /tmp/r.resp;\\n}\\n" > /etc/nginx/sites-available/default'`);
    await srv.executeCommand('systemctl start nginx');
    const ca = pemToCert(await srv.executeCommand(`cat ${CA}/ca.crt`))!;
    const socket = srv.getTcpStack().connect('127.0.0.1', 443)!;
    const client = new TlsClientSession({
      verifier: new CertificateVerifier({ trustAnchors: [ca] }), serverName: `${name}.lab`, requireOcspStaple: true,
    } as never);
    runTlsHandshakeOverSocket(socket, client);
    return client;
  }

  it('certificat good : la réponse agrafée est vérifiée par le client', async () => {
    expect((await stapledHandshake('good')).result).toBe('success');
  });

  it('certificat revoked : le client abandonne (certificate_revoked)', async () => {
    const client = await stapledHandshake('bad');
    expect(client.result).toBe('failure');
    expect(client.lastAlert?.description).toBe('certificate_revoked');
  });
});
