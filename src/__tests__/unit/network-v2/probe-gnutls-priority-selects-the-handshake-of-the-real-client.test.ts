/**
 * Sonde : `TLS_CIPHER_SUITE` n'est pas une chaine que l'on affiche, elle decide
 * de la poignee de main : versions, suites, groupes et algorithmes de signature
 * annonces par le client, donc ce que le serveur peut choisir, et la phrase que
 * libldap rapporte quand cela echoue (« A TLS fatal alert has been received. »
 * si le serveur repond par une alerte, « No or insufficient priorities were
 * set. » si rien ne part faute de version utilisable).
 *
 * Autorite : le vrai `ldapsearch` 2.6.10 (GnuTLS 3.8.3) lance contre un vrai
 * `openssl s_server` 3.0.13 (RSA ou ECDSA, options -tls1_2, -tls1_3,
 * -no_tls1_3, -cipher, -ciphersuites, -groups) ; pour chaque couple, la ligne
 * `TLS: can't connect: ...` de `-d` et la suite retenue lue dans `-trace` sont
 * consignees dans `gnutls-handshake-corpus.json` (53 couples). Le laboratoire
 * du simulateur rejoue les memes couples avec `TlsServerSession` configure
 * comme `s_server` (preference du client, niveau de securite 2 d'Ubuntu).
 *
 * Constats qui ont corrige le code : un client sans groupe (`-GROUP-ALL`)
 * annonce quand meme des suites ECDHE, et le serveur d'OpenSSL retient alors
 * une suite RSA, alors que la pile simulee choisissait l'ECDHE puis echouait ;
 * un client dont la liste de signatures ne contient rien que la cle du serveur
 * sache produire (ou sans extension du tout, SHA-1 par defaut refuse des le
 * niveau 1) est refuse « no suitable signature algorithm » meme pour une suite
 * a echange RSA ; un client TLS 1.2 sans groupe n'echoue plus avant d'ecrire.
 *
 * Mesure avant la modification : 34 des 53 cas tombent. Passent des deux cotes :
 * les 19 cas dont l'offre est celle du client par defaut (NORMAL, PFS,
 * SECURE128, LEGACY, %COMPAT, %SERVER_PRECEDENCE, ...), qui servent de temoins.
 *
 * Limite assumee et nommee : SECURE256 demande secp384r1, secp521r1, ffdhe8192
 * et des signatures SHA-384/512 que la pile ne calcule pas ; un vrai serveur
 * accepte, le simulateur repond par une alerte (dernier test du fichier).
 * Non attestable : le serveur OpenSSL d'Ubuntu retire 3DES de `ALL` (cas
 * ecarte, c'est le tableau de chiffrements OpenSSL du simulateur, non GnuTLS).
 */
import { describe, expect, it } from 'vitest';
import { CertificateAuthority } from '@/network/pki/CertificateAuthority';
import type { TlsServerConfig } from '@/network/tls/TlsServerSession';
import { connectWithPriority } from './gnutls-handshake-support';
import { loadJson } from './openldap-replay-support';

interface HandshakeCase {
  readonly serverArgs: readonly string[];
  readonly ec: boolean;
  readonly priority: string;
  readonly suite: string | null;
  readonly client: readonly string[];
}

const corpus = loadJson<readonly HandshakeCase[]>('gnutls-handshake-corpus.json');
const NOW = Date.parse('2026-02-01T00:00:00Z');

const OPENSSL_GROUPS: Readonly<Record<string, string>> = { X25519: 'x25519', 'P-256': 'secp256r1' };

function serverConfig(args: readonly string[], ec: boolean): TlsServerConfig {
  const authority = CertificateAuthority.generate('CN=Lab Root CA', { now: NOW, algorithm: ec ? 'ecdsa' : 'rsa' });
  const leaf = authority.issueCertificate({ subject: 'CN=vm', notBefore: NOW - 1000, notAfter: NOW + 1e9 });
  const config: { -readonly [K in keyof TlsServerConfig]: TlsServerConfig[K] } = {
    serverCert: leaf.cert, serverPrivateKey: leaf.privateKey, supportedGroups: ['x25519', 'secp256r1'], preferServerCiphers: false, securityLevel: 2,
  };
  for (let i = 0; i < args.length; i++) {
    const flag = args[i];
    if (flag === '-tls1_2' || flag === '-no_tls1_3') config.protocols = ['1.2'];
    else if (flag === '-tls1_3') config.protocols = ['1.3'];
    else if (flag === '-cipher') config.cipherList = args[++i];
    else if (flag === '-ciphersuites') config.tls13Ciphersuites = args[++i];
    else if (flag === '-groups') config.supportedGroups = args[++i].split(':').map((group) => OPENSSL_GROUPS[group] ?? group.toLowerCase());
  }
  return config;
}

const BEYOND_THE_STACK: ReadonlySet<string> = new Set(['SECURE256']);

async function connect(entry: HandshakeCase): Promise<{ lines: string[]; suite: string | null }> {
  return connectWithPriority(entry.priority, () => serverConfig(entry.serverArgs, entry.ec));
}

function failureLine(lines: readonly string[]): string | null {
  return lines.find((line) => line.startsWith("TLS: can't connect")) ?? null;
}

describe('a priority string selects the handshake the real client has with a real server', () => {
  it('the corpus is sound: it holds successes and refusals of every sort', () => {
    expect(corpus.length).toBeGreaterThan(40);
    expect(corpus.filter((entry) => entry.suite !== null).length).toBeGreaterThan(15);
    expect(corpus.filter((entry) => entry.client.some((line) => line.includes('fatal alert'))).length).toBeGreaterThan(10);
    expect(corpus.some((entry) => entry.client.some((line) => line.includes('insufficient priorities')))).toBe(true);
  });

  const handshakes = corpus.filter((entry) => !entry.client.some((line) => line.startsWith('TLS: could not set')));
  for (const entry of handshakes.filter((candidate) => !BEYOND_THE_STACK.has(candidate.priority))) {
    it(`${entry.priority} against ${entry.serverArgs.join(' ') || 'defaults'}${entry.ec ? ' (ECDSA)' : ''}`, async () => {
      const outcome = await connect(entry);
      const expected = entry.client.find((line) => line.startsWith("TLS: can't connect")) ?? null;
      expect(failureLine(outcome.lines)).toBe(expected);
      expect(outcome.suite).toBe(entry.suite);
    });
  }

  it('a priority string needing groups and schemes the stack cannot compute fails where a real server would accept', async () => {
    const witness = await connect({ serverArgs: [], ec: false, priority: 'NORMAL', suite: 'TLS_AES_256_GCM_SHA384', client: [] });
    expect(witness.suite).toBe('TLS_AES_256_GCM_SHA384');
    for (const entry of handshakes.filter((candidate) => BEYOND_THE_STACK.has(candidate.priority))) {
      expect(entry.suite).not.toBeNull();
      const outcome = await connect(entry);
      expect(outcome.suite).toBeNull();
      expect(failureLine(outcome.lines)).toBe("TLS: can't connect: A TLS fatal alert has been received..");
    }
  });
});
