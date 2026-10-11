/**
 * Sonde : les donnees de liaison de canal (RFC 5929) et la force de session
 * que la pile TLS du simulateur fournit a SASL sont celles de la pile reelle.
 *
 * Autorite : `tls-unique` est mesure avec le module `ssl` de Python (OpenSSL
 * 3.x, `SSLSocket.get_channel_binding`) pris comme SERVEUR face au client du
 * simulateur en TLS 1.2, ce que libldap lit chez GnuTLS (`GNUTLS_CB_TLS_UNIQUE`,
 * premier message Finished). En TLS 1.3 l'autorite est le vrai `ldapsearch` (GnuTLS)
 * lui-meme, pas Python (qui rend un Finished) : avec `SASL_CBINDING tls-unique`,
 * `gss_init_sec_context` recoit des liaisons NULLES sur une session TLS 1.3 et le
 * champ Bnd de l'authenticator est nul, alors qu'il est non nul sur une session
 * TLS 1.2 forcee par `TLS_CIPHER_SUITE NORMAL:-VERS-TLS1.3`.
 * `tls-server-end-point` est le SHA-256 de l'encodage DER du certificat tel que
 * `openssl x509 -outform der` l'ecrit. Les tailles de cle viennent de
 * `gnutls_cipher_get_key_size` (GnuTLS 3.8.3, la fonction que
 * `tlsg_session_strength` de libldap appelle) pour chaque algorithme symetrique.
 * Non attestable : ARIA (le GnuTLS d'Ubuntu n'en a pas ; la taille retenue est
 * celle que le nom de l'algorithme annonce) et `tls-unique` d'une session reprise
 * (le premier Finished est alors celui du serveur, regle du RFC 5929 §3.1, non
 * mesuree ici).
 *
 * Mesure avant la modification, le module `tls/channelBinding.ts` mis a part (sans
 * lui le fichier ne se charge pas) : ni l'etat de canal du client TLS ni la table
 * des tailles de cle des suites TLS 1.2 n'existaient — 66 des 70 cas tombent.
 * Passent avant comme apres, parce que le module neuf les porte seul : le temoin
 * « le client du simulateur negocie TLS 1.2 avec le serveur Python », la formule
 * `tls-server-end-point`, les tailles de cle des suites TLS 1.3 et « une session
 * sans negociation n'a pas de force ».
 */
import { describe, it, expect } from 'vitest';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { TlsClientSession } from '@/network/tls/TlsClientSession';
import { CertificateVerifier } from '@/network/pki/CertificateVerifier';
import { pemToCert } from '@/network/pki/pem';
import { cipherKeyBits, tlsServerEndPoint } from '@/network/tls/channelBinding';
import { LEGACY_CIPHER_SUITES } from '@/network/tls/legacy/legacyCipherSuites';
import { realCertificate, runSimClient, type RealKeyMaterial } from './_realOpenssl';

const SERVER = `
import ssl, socket, sys
context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
context.load_cert_chain(sys.argv[1], sys.argv[2])
if sys.argv[4] == '1.2':
    context.maximum_version = ssl.TLSVersion.TLSv1_2
listener = socket.socket()
listener.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
listener.bind(('127.0.0.1', int(sys.argv[3])))
listener.listen(1)
print('READY', flush=True)
connection, _ = listener.accept()
tls = context.wrap_socket(connection, server_side=True)
binding = tls.get_channel_binding('tls-unique')
print('BINDING', binding.hex() if binding else 'none', flush=True)
tls.recv(4096)
tls.sendall(b'HTTP/1.0 200 OK\\r\\nContent-Length: 2\\r\\n\\r\\nok')
tls.close()
`;

interface PythonServer { readonly port: number; binding(): Promise<string>; stop(): void }

async function startPythonServer(material: RealKeyMaterial, version: '1.2' | '1.3'): Promise<PythonServer> {
  const port = 14000 + Math.floor(Math.random() * 20000);
  const child: ChildProcess = spawn('python3', ['-I', '-c', SERVER, material.certificatePath, material.keyPath, String(port), version], { stdio: ['ignore', 'pipe', 'pipe'] });
  let log = '';
  child.stdout!.on('data', (data) => { log += data; });
  child.stderr!.on('data', (data) => { log += data; });
  await new Promise<void>((resolve) => {
    const timer = setInterval(() => { if (log.includes('READY')) { clearInterval(timer); resolve(); } }, 20);
  });
  const binding = async (): Promise<string> => {
    for (let attempt = 0; attempt < 200; attempt++) {
      const match = /BINDING (\S+)/.exec(log);
      if (match) return match[1];
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error(`no binding reported: ${log}`);
  };
  return { port, binding, stop: () => { child.kill(); } };
}

async function connect(version: '1.2' | '1.3') {
  const material = realCertificate('real.lab');
  const server = await startPythonServer(material, version);
  const verifier = new CertificateVerifier({ trustAnchors: [material.certificate], clock: () => Date.now() });
  const client = new TlsClientSession({ verifier, serverName: 'real.lab', versions: version === '1.2' ? ['1.2'] : ['1.3'] } as never);
  const run = await runSimClient(server.port, client);
  const reported = await server.binding();
  server.stop();
  return { material, client, run, reported };
}

const hex = (value: Uint8Array): string => Buffer.from(value).toString('hex');

describe('tls-unique against the Python ssl server', () => {
  it('the simulated client negotiates TLS 1.2 with the Python server (witness)', async () => {
    const { client, run } = await connect('1.2');
    expect(client.result).toBe('success');
    expect(client.negotiatedVersion).toBe('1.2');
    expect(run.response).toContain('200 OK');
  }, 60000);

  it('the first Finished the client sent is the binding the real server reports', async () => {
    const { client, reported } = await connect('1.2');
    expect(reported).not.toBe('none');
    expect(hex(client.uniqueChannelBinding!)).toBe(`${Buffer.from('tls-unique:').toString('hex')}${reported}`);
  }, 60000);

  it('the binding of a TLS 1.2 handshake is the prefix and twelve bytes of Finished', async () => {
    const { client } = await connect('1.2');
    expect(client.uniqueChannelBinding).toHaveLength('tls-unique:'.length + 12);
  }, 60000);

  it('TLS 1.3 gives no tls-unique, as GnuTLS gives none to the real client', async () => {
    const { client } = await connect('1.3');
    expect(client.negotiatedVersion).toBe('1.3');
    expect(client.uniqueChannelBinding).toBeNull();
  }, 60000);
});

describe('tls-server-end-point against openssl', () => {
  it('is the prefix followed by the SHA-256 of the DER openssl writes for the certificate', () => {
    const material = realCertificate('real.lab');
    const der = spawnSync('openssl', ['x509', '-in', material.certificatePath, '-outform', 'der']).stdout;
    const certificate = pemToCert(readFileSync(material.certificatePath, 'utf8'))!;
    expect(hex(tlsServerEndPoint(certificate))).toBe(
      `${Buffer.from('tls-server-end-point:').toString('hex')}${createHash('sha256').update(der).digest('hex')}`,
    );
  });
});

describe('session strength against gnutls_cipher_get_key_size', () => {
  const MEASURED: Readonly<Record<string, number>> = {
    '3DES_EDE_CBC': 192, AES_128_CBC: 128, AES_256_CBC: 256, AES_128_GCM: 128, AES_256_GCM: 256,
    AES_128_CCM: 128, AES_256_CCM: 256, AES_128_CCM_8: 128, AES_256_CCM_8: 256, CHACHA20_POLY1305: 256,
    CAMELLIA_128_CBC: 128, CAMELLIA_256_CBC: 256,
  };
  const ANNOUNCED_BY_NAME: Readonly<Record<string, number>> = { ARIA_128_GCM: 128, ARIA_256_GCM: 256 };

  for (const definition of LEGACY_CIPHER_SUITES) {
    it(`${definition.name} reports ${MEASURED[definition.cipher] ?? ANNOUNCED_BY_NAME[definition.cipher]} bits`, () => {
      const expected = MEASURED[definition.cipher] ?? ANNOUNCED_BY_NAME[definition.cipher];
      expect(expected).toBeDefined();
      expect(cipherKeyBits({ version: '1.2', suite: definition.name })).toBe(expected);
    });
  }

  it('the TLS 1.3 suites report the key size of their AEAD', () => {
    expect(cipherKeyBits({ version: '1.3', suite: 'TLS_AES_128_GCM_SHA256' })).toBe(128);
    expect(cipherKeyBits({ version: '1.3', suite: 'TLS_AES_256_GCM_SHA384' })).toBe(256);
    expect(cipherKeyBits({ version: '1.3', suite: 'TLS_CHACHA20_POLY1305_SHA256' })).toBe(256);
  });

  it('a session that negotiated nothing has no strength', () => {
    expect(cipherKeyBits({ version: null, suite: null })).toBeNull();
  });
});
