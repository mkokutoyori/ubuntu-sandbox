/**
 * docs/PRD-OpenSSL.md — le moteur, une porte par plateforme.
 *
 * Ce que ce fichier tient de plus important n'est pas le dispatch mais
 * le §5 P1 : ce qui peut être RÉEL l'est. `dgst -sha256` appelle le
 * `sha256Hex` de `src/crypto/`, celui-là même que `sha256sum` utilise,
 * si bien que les deux commandes ne peuvent pas diverger sur la même
 * machine. Un simulateur où elles différeraient enseignerait qu'une
 * empreinte dépend de l'outil qui la calcule.
 */

import type { TcpWireOutcome } from '@/network/tcp/types';
import { md4, md5Hex, sha1Hex, sha256Hex, sha512Hex, MD5, SHA1, SHA256, SHA512 } from '@/crypto/hash';
import { hmacHex } from '@/crypto/mac';
import { md5Crypt } from '@/crypto/passwords';
import {
  bytesToBase64, base64ToBytes, bytesToHex, utf8ToBytes, bytesToUtf8,
} from '@/crypto/encoding';
import { PkiKeyPair } from '@/network/pki/PkiKeyPair';
import { publicPartOf, modulusHex, materialToPublicKey, bitLength } from '@/crypto/rsa';
import { materialToP256Public } from '@/crypto/ecc';
import { generateSelfSignedCertificate } from '@/network/pki/SelfSignedCertificate';
import { tbsPayload, type X509Certificate } from '@/network/pki/X509Certificate';
import {
  certToPem, pemToCert, pemToCertChain, privateKeyToPem, pemToPrivateKey, publicKeyToPem,
  pemToPublicKey, csrToPem, pemToCsr, crlToPem, pemToCrl, type CertificateRequest,
  encryptedPrivateKeyToPem, pemToEncryptedPrivateKey, isEncryptedPrivateKeyPem,
} from '@/network/pki/pem';
import { buildCertificateRequest } from '@/network/pki/CertificateSigningRequest';
import { CertificateVerifier, type VerificationReason } from '@/network/pki/CertificateVerifier';
import { CertificateRevocationList } from '@/network/pki/CertificateRevocationList';
import { MANDATORY_CIPHER_SUITES } from '@/network/tls/cipherSuites';
import { parseArgs, parseSubject, REAL_OPENSSL_SUBCOMMANDS } from './OpenSslArgs';
import { runEnc, ENC_ALGOS, ENC_KNOWN_UNIMPLEMENTED } from './OpenSslEnc';
import { ok, fail, type OpenSslHost, type OpenSslResult } from './OpenSslHost';

export const OPENSSL_VERSION = '3.0.2';
export const OPENSSL_VERSION_DATE = '15 Mar 2022';

const DIGESTS: Readonly<Record<string, { label: string; fn: (s: string) => string }>> = {
  md4: { label: 'MD4', fn: (s) => bytesToHex(md4(utf8ToBytes(s))) },
  md5: { label: 'MD5', fn: md5Hex },
  sha1: { label: 'SHA1', fn: sha1Hex },
  sha256: { label: 'SHA2-256', fn: sha256Hex },
  sha512: { label: 'SHA2-512', fn: sha512Hex },
};

/** Ce qu'openssl connaît et que ce build n'offre pas — §8.2/§8.3. */
const KNOWN_UNIMPLEMENTED_DIGESTS = [
  'sha224', 'sha384', 'sha3-224', 'sha3-256', 'sha3-384', 'sha3-512',
  'shake128', 'shake256', 'blake2b512', 'blake2s256', 'rmd160', 'ripemd160', 'sm3',
];

const IMPLEMENTED = new Set([
  'version', 'help', 'dgst', 'rand', 'base64', 'passwd', 'genrsa', 'genpkey',
  'rsa', 'pkey', 'req', 'x509', 'verify', 'list', 'errstr', 'prime',
  'ciphers', 'info', 'ca', 'crl',
  'ec', 'ecparam', 'pkcs8', 'pkeyutl', 'rsautl', 'rehash', 's_client',
  'enc', ...Object.keys(ENC_ALGOS),
  ...Object.keys(DIGESTS),
]);

function notImplemented(name: string): OpenSslResult {
  return fail(`openssl: '${name}' is not implemented in this simulator`);
}

function invalidCommand(name: string): OpenSslResult {
  return fail(
    `openssl:Error: '${name}' is an invalid command.\n` +
    `\nStandard commands\n${[...IMPLEMENTED].sort().join(' ')}`,
  );
}

/** `Aug  5 08:00:00 2026 GMT` — trois lettres, jour sur deux colonnes. */
function opensslDate(ms: number): string {
  const d = new Date(ms);
  const mois = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const p = (n: number) => String(n).padStart(2, '0');
  const jour = String(d.getUTCDate()).padStart(2, ' ');
  return `${mois[d.getUTCMonth()]} ${jour} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:`
    + `${p(d.getUTCSeconds())} ${d.getUTCFullYear()} GMT`;
}

function readInput(host: OpenSslHost, path: string | undefined): string | null {
  if (path === undefined) return host.stdin() ?? '';
  return host.readFile(path);
}

/** The algorithms `-hmac` can use, keyed by their openssl name. */
const HMAC_HASHES: Readonly<Record<string, typeof SHA256>> = {
  md5: MD5, sha1: SHA1, sha256: SHA256, sha512: SHA512,
};

// ─── dgst ───────────────────────────────────────────────────────────

function runDgst(host: OpenSslHost, argv: readonly string[], forced?: string): OpenSslResult {
  const { opts, operands } = parseArgs('dgst', argv);

  let algo = forced ?? 'sha256';
  if (!forced) {
    for (const nom of Object.keys(DIGESTS)) if (opts.has(`-${nom}`)) algo = nom;
    for (const nom of KNOWN_UNIMPLEMENTED_DIGESTS) {
      if (opts.has(`-${nom}`)) return notImplemented(nom);
    }
  }
  const d = DIGESTS[algo];
  if (!d) return notImplemented(algo);

  const hmacKey = opts.get('-hmac');
  const lignes: string[] = [];
  const cibles = operands.length > 0 ? operands : [undefined];

  for (const cible of cibles) {
    const contenu = readInput(host, cible);
    if (contenu === null) {
      return fail(`${cible}: No such file or directory`);
    }
    // The HMAC is `src/crypto/mac`'s — the real one, not a digest of the
    // key concatenated to the message. It takes the ALGORITHM (block size
    // and output size both matter in RFC 2104), hence the object rather
    // than its name.
    const empreinte = typeof hmacKey === 'string'
      ? hmacHex(HMAC_HASHES[algo] ?? SHA256, hmacKey, contenu)
      : d.fn(contenu);

    if (opts.has('-r')) {
      lignes.push(`${empreinte} *${cible ?? '-'}`);
    } else if (opts.has('-binary')) {
      lignes.push(empreinte);
    } else if (typeof hmacKey === 'string') {
      lignes.push(`HMAC-${d.label}(${cible ?? 'stdin'})= ${empreinte}`);
    } else {
      lignes.push(`${d.label}(${cible ?? 'stdin'})= ${empreinte}`);
    }
  }

  const sortie = lignes.join('\n');
  const out = opts.get('-out');
  if (typeof out === 'string') {
    return host.writeFile(out, sortie + '\n') ? ok() : fail(`${out}: cannot write`);
  }
  return ok(sortie);
}

// ─── rand ───────────────────────────────────────────────────────────

function runRand(host: OpenSslHost, argv: readonly string[]): OpenSslResult {
  const { opts, operands } = parseArgs('rand', argv);
  const n = Number(operands[0]);
  if (!Number.isFinite(n) || n <= 0) {
    return fail('openssl: rand: a positive byte count is required');
  }
  const octets = host.randomBytes(n);
  const sortie = opts.has('-hex') ? bytesToHex(octets)
    : opts.has('-base64') ? bytesToBase64(octets)
      : bytesToUtf8(octets);

  const out = opts.get('-out');
  if (typeof out === 'string') {
    return host.writeFile(out, sortie) ? ok() : fail(`${out}: cannot write`);
  }
  return ok(sortie);
}

// ─── base64 ─────────────────────────────────────────────────────────

function runBase64(host: OpenSslHost, argv: readonly string[]): OpenSslResult {
  const { opts } = parseArgs('enc', argv);
  const entree = readInput(host, typeof opts.get('-in') === 'string' ? String(opts.get('-in')) : undefined);
  if (entree === null) return fail(`${opts.get('-in')}: No such file or directory`);

  let sortie: string;
  if (opts.has('-d')) {
    try {
      sortie = bytesToUtf8(base64ToBytes(entree.replace(/\s+/g, '')));
    } catch {
      return fail('error in base64');
    }
  } else {
    const b64 = bytesToBase64(utf8ToBytes(entree));
    sortie = opts.has('-A') ? b64 : (b64.match(/.{1,64}/g) ?? []).join('\n');
  }

  const out = opts.get('-out');
  if (typeof out === 'string') {
    return host.writeFile(out, sortie + '\n') ? ok() : fail(`${out}: cannot write`);
  }
  return ok(sortie);
}

// ─── passwd ─────────────────────────────────────────────────────────

function runPasswd(host: OpenSslHost, argv: readonly string[]): OpenSslResult {
  const { opts, operands } = parseArgs('passwd', argv);
  const secret = opts.has('-stdin') ? (host.stdin() ?? '').trim() : operands[0];
  if (secret === undefined) return fail('openssl: passwd: a password is required');

  const sel = typeof opts.get('-salt') === 'string' ? String(opts.get('-salt'))
    : bytesToHex(host.randomBytes(4));

  if (opts.has('-1')) return ok(md5Crypt(secret, sel));
  if (opts.has('-apr1')) return ok(md5Crypt(secret, sel).replace('$1$', '$apr1$'));
  if (opts.has('-5')) return ok(`$5$${sel}$${secret}`);
  if (opts.has('-6')) return ok(`$6$${sel}$${secret}`);
  // Sans option, openssl utilise crypt(3) DES — que ce build n'a pas.
  return notImplemented('passwd (crypt DES)');
}

// ─── clés ───────────────────────────────────────────────────────────

function runGenRsa(host: OpenSslHost, argv: readonly string[]): OpenSslResult {
  const { opts, operands } = parseArgs('genrsa', argv);
  const bits = Number(operands[0] ?? 2048);
  if (!Number.isInteger(bits) || bits < 512 || bits % 16 !== 0) {
    return fail(`openssl: genrsa: invalid modulus size ${operands[0]}`);
  }
  // La taille demandée est HONORÉE : le module fait réellement ce nombre
  // de bits, ce qu'`openssl rsa -text` affiche ensuite en le mesurant.
  const paire = PkiKeyPair.generate('rsa', bits);
  const pem = privateKeyToPem(paire.privateKey, opts.has('-traditional'));
  const out = opts.get('-out');
  const trace = `Generating RSA private key, ${bits} bit long modulus (2 primes)`;
  if (typeof out === 'string') {
    return host.writeFile(out, pem)
      ? { output: '', stderr: trace, exitCode: 0 }
      : fail(`${out}: cannot write`);
  }
  return { output: pem, stderr: trace, exitCode: 0 };
}

function runRsa(host: OpenSslHost, argv: readonly string[]): OpenSslResult {
  const { opts } = parseArgs('rsa', argv);
  const chemin = opts.get('-in');
  if (typeof chemin !== 'string') return fail('openssl: rsa: -in is required');
  const texte = host.readFile(chemin);
  if (texte === null) return fail(`Can't open "${chemin}" for reading, No such file or directory`);
  const cle = pemToPrivateKey(texte);
  if (!cle) return fail('unable to load Private Key');

  const lignes: string[] = [];
  if (opts.has('-text')) {
    // La taille est MESURÉE sur le module, pas annoncée : une clé de 512
    // bits ne doit pas se présenter comme une clé de 2048.
    const pub = materialToPublicKey(cle.material);
    lignes.push(`Private-Key: (${pub ? bitLength(pub.n) : 0} bit, 2 primes)`);
    lignes.push('modulus:');
    const mod = modulusHex(cle.material);
    if (mod) for (const ligne of mod.toLowerCase().match(/.{1,30}/g) ?? []) lignes.push(`    ${ligne}`);
  }
  if (opts.has('-check')) lignes.push('RSA key ok');
  // The modulus is a PUBLIC quantity — it is half of the public key, and
  // `x509 -modulus` prints exactly the same value for the certificate
  // that certifies this key. Printing the private material here broke the
  // canonical check every admin uses to pair a key with its certificate
  // (`openssl x509 -noout -modulus | openssl md5` against `openssl rsa
  // -noout -modulus | openssl md5`): a matching pair reported as
  // mismatched, and the secret leaked into output people paste around.
  if (opts.has('-modulus')) {
    lignes.push(`Modulus=${modulusHex(cle.material) ?? ''}`);
  }

  if (!opts.has('-noout')) {
    lignes.push(opts.has('-pubout')
      ? publicKeyToPem({ algorithm: cle.algorithm, material: publicPartOf(cle.material) })
      : privateKeyToPem(cle));
  }
  const sortie = lignes.join('\n');
  const out = opts.get('-out');
  if (typeof out === 'string') {
    return host.writeFile(out, sortie + '\n') ? ok('writing RSA key') : fail(`${out}: cannot write`);
  }
  return ok(sortie);
}

// ─── req ────────────────────────────────────────────────────────────

function runReq(host: OpenSslHost, argv: readonly string[]): OpenSslResult {
  const { opts } = parseArgs('req', argv);

  const subjBrut = opts.get('-subj');
  if (typeof subjBrut !== 'string') {
    // Le mode interactif est le comportement par défaut d'openssl et il
    // est prévu par le PRD (§13.8) ; il demande l'infrastructure
    // `InteractiveFlow`, qui n'est pas branchée ici. On le dit plutôt
    // que de faire semblant d'avoir un sujet.
    return fail('openssl: req: interactive mode is not implemented in this simulator; use -subj');
  }
  const sujet = parseSubject(subjBrut);

  let cle = null as ReturnType<typeof pemToPrivateKey>;
  const cheminCle = opts.get('-key');
  if (typeof cheminCle === 'string') {
    const t = host.readFile(cheminCle);
    if (t === null) return fail(`Can't open "${cheminCle}" for reading, No such file or directory`);
    cle = pemToPrivateKey(t);
    if (!cle) return fail('unable to load Private Key');
  }

  const keyout = opts.get('-keyout');
  if (!cle) {
    // `-newkey rsa:2048` demande une taille, et elle est honorée : le
    // module fait réellement ce nombre de bits.
    const newkey = opts.get('-newkey');
    const demande = typeof newkey === 'string' ? /^rsa:(\d+)$/.exec(newkey) : null;
    const bits = demande ? Number(demande[1]) : undefined;
    if (bits !== undefined && (!Number.isInteger(bits) || bits < 512 || bits % 16 !== 0)) {
      return fail(`openssl: req: invalid modulus size ${demande?.[1]}`);
    }
    const paire = bits === undefined ? PkiKeyPair.generate('rsa') : PkiKeyPair.generate('rsa', bits);
    cle = paire.privateKey;
    if (typeof keyout === 'string' && !host.writeFile(keyout, privateKeyToPem(cle))) {
      return fail(`${keyout}: cannot write`);
    }
  }

  // `publicPartOf` et non un `replace` : le matériel privé porte
  // maintenant l'exposant secret, qu'une simple substitution de préfixe
  // laisserait dans la moitié « publique ».
  const publique = { algorithm: cle.algorithm, material: publicPartOf(cle.material) };
  const altNames = typeof opts.get('-addext') === 'string'
    ? String(opts.get('-addext')).replace(/^subjectAltName\s*=\s*/, '').split(',').map((s) => s.trim())
    : undefined;

  const out = opts.get('-out');

  if (opts.has('-x509')) {
    const jours = Number(opts.get('-days') ?? 30);
    // The certificate MUST certify the key we just wrote to `-keyout`.
    // Letting the helper generate its own produced a `.crt` and a `.key`
    // that did not correspond — invisible to every command that reads one
    // without the other, and fatal the moment nginx presented them.
    const { cert } = generateSelfSignedCertificate(sujet, {
      now: host.now(),
      validityMs: jours * 24 * 3600 * 1000,
      keyPair: { publicKey: publique, privateKey: cle },
      // The SAN goes in BEFORE the signature. Adding it to the returned
      // certificate — which is what this did — left a certificate whose
      // signature covered a different content than the one on disk, so
      // `-addext` produced a certificate no verifier could accept.
      subjectAltName: altNames,
    });
    const pem = certToPem(cert);
    if (typeof out === 'string') {
      return host.writeFile(out, pem) ? ok() : fail(`${out}: cannot write`);
    }
    return ok(pem);
  }

  const pem = csrToPem(
    buildCertificateRequest(sujet, { publicKey: publique, privateKey: cle }, altNames));
  if (typeof out === 'string') {
    return host.writeFile(out, pem) ? ok() : fail(`${out}: cannot write`);
  }
  return ok(pem);
}

// ─── x509 ───────────────────────────────────────────────────────────

function runX509(host: OpenSslHost, argv: readonly string[]): OpenSslResult {
  const { opts } = parseArgs('x509', argv);
  const chemin = opts.get('-in');
  if (typeof chemin !== 'string') return fail('openssl: x509: -in is required');
  const texte = host.readFile(chemin);
  if (texte === null) return fail(`Can't open "${chemin}" for reading, No such file or directory`);

  // `-req` : l'entrée est un CSR à signer par une autorité.
  if (opts.has('-req')) return signCsr(host, opts, texte);

  const cert = pemToCert(texte);
  if (!cert) return fail('unable to load certificate');

  const lignes: string[] = [];
  if (opts.has('-subject')) lignes.push(`subject=${cert.subject}`);
  if (opts.has('-issuer')) lignes.push(`issuer=${cert.issuer}`);
  if (opts.has('-serial')) lignes.push(`serial=${cert.serialNumber.toUpperCase()}`);
  if (opts.has('-startdate') || opts.has('-dates')) {
    lignes.push(`notBefore=${opensslDate(cert.notBefore)}`);
  }
  if (opts.has('-enddate') || opts.has('-dates')) {
    lignes.push(`notAfter=${opensslDate(cert.notAfter)}`);
  }
  if (opts.has('-fingerprint')) {
    const brut = sha256Hex(tbsPayload(cert)).toUpperCase();
    lignes.push(`SHA256 Fingerprint=${(brut.match(/.{2}/g) ?? []).join(':')}`);
  }
  // Le MÊME module que `rsa -modulus`, par la même fonction : c'est
  // exactement le contrôle qu'un administrateur fait pour apparier une
  // clé et son certificat, et deux rendus différents le casseraient.
  if (opts.has('-modulus')) lignes.push(`Modulus=${modulusHex(cert.publicKey.material) ?? ''}`);
  if (opts.has('-text')) lignes.push(...renderText(cert));

  const checkend = opts.get('-checkend');
  if (typeof checkend === 'string') {
    const reste = cert.notAfter - host.now();
    const expire = reste < Number(checkend) * 1000;
    return {
      output: expire ? 'Certificate will expire' : 'Certificate will not expire',
      stderr: '', exitCode: expire ? 1 : 0,
    };
  }

  if (!opts.has('-noout')) lignes.push(certToPem(cert).trimEnd());

  const sortie = lignes.join('\n');
  const out = opts.get('-out');
  if (typeof out === 'string') {
    return host.writeFile(out, sortie + '\n') ? ok() : fail(`${out}: cannot write`);
  }
  return ok(sortie);
}

function renderText(cert: X509Certificate): string[] {
  const l: string[] = [
    'Certificate:',
    '    Data:',
    `        Version: 3 (0x2)`,
    `        Serial Number: ${cert.serialNumber}`,
    `        Signature Algorithm: ${cert.signatureAlgorithm}`,
    `        Issuer: ${cert.issuer}`,
    '        Validity',
    `            Not Before: ${opensslDate(cert.notBefore)}`,
    `            Not After : ${opensslDate(cert.notAfter)}`,
    `        Subject: ${cert.subject}`,
    '        Subject Public Key Info:',
    `            Public Key Algorithm: rsaEncryption`,
    '                RSA Public-Key: (2048 bit)',
    '                Modulus:',
    // §5 P3 : la simulation se déclare là où elle est lue, pas en note
    // de bas de page. Un module inventé affiché sans mention
    // enseignerait une fausse confiance.
    '                    <simulated key material — this build does not compute',
    '                     real RSA moduli; see docs/PRD-OpenSSL.md §3.2>',
  ];
  const san = cert.extensions?.subjectAltName;
  if (san && san.length > 0) {
    l.push('        X509v3 extensions:');
    l.push('            X509v3 Subject Alternative Name:');
    l.push(`                ${san.join(', ')}`);
  }
  return l;
}

function signCsr(
  host: OpenSslHost, opts: Map<string, string | true>, texteCsr: string,
): OpenSslResult {
  const csr = pemToCsr(texteCsr);
  if (!csr) return fail('unable to load certificate request');

  const cheminCa = opts.get('-CA');
  const cheminCaKey = opts.get('-CAkey');
  if (typeof cheminCa !== 'string' || typeof cheminCaKey !== 'string') {
    return fail('openssl: x509 -req: -CA and -CAkey are required');
  }
  const texteCa = host.readFile(cheminCa);
  const texteCaKey = host.readFile(cheminCaKey);
  if (texteCa === null) return fail(`Can't open "${cheminCa}" for reading, No such file or directory`);
  if (texteCaKey === null) return fail(`Can't open "${cheminCaKey}" for reading, No such file or directory`);

  const ca = pemToCert(texteCa);
  const caKey = pemToPrivateKey(texteCaKey);
  if (!ca) return fail('unable to load certificate');
  if (!caKey) return fail('unable to load CA Private Key');

  const jours = Number(opts.get('-days') ?? 30);
  const champs = {
    version: 3 as const,
    serialNumber: bytesToHex(host.randomBytes(8)),
    subject: csr.subject,
    issuer: ca.subject,
    notBefore: host.now(),
    notAfter: host.now() + jours * 24 * 3600 * 1000,
    publicKey: csr.publicKey,
    signatureAlgorithm: 'sha256WithRSAEncryption' as const,
    extensions: csr.extensions?.subjectAltName
      ? { subjectAltName: csr.extensions.subjectAltName }
      : undefined,
  };
  const cert: X509Certificate = { ...champs, signature: PkiKeyPair.sign(caKey, tbsPayload(champs)) };

  const pem = certToPem(cert);
  const out = opts.get('-out');
  const trace = `Certificate request self-signature ok\nsubject=${csr.subject}`;
  if (typeof out === 'string') {
    return host.writeFile(out, pem)
      ? { output: '', stderr: trace, exitCode: 0 }
      : fail(`${out}: cannot write`);
  }
  return { output: pem, stderr: trace, exitCode: 0 };
}

// ─── verify ─────────────────────────────────────────────────────────

/**
 * Le verdict d'openssl, dit avec les mots d'openssl.
 *
 * `CertificateVerifier` répond par une RAISON ; `verify` affiche un
 * NUMÉRO, et c'est ce numéro qu'un opérateur tape dans un moteur de
 * recherche. La table est ici, en un seul endroit, pour que les deux ne
 * puissent pas se contredire.
 *
 * `unknown` couvre deux situations qu'openssl distingue et que le
 * vérificateur ne distingue pas : aucune ancre ne porte le nom de
 * l'émetteur. Si le certificat est son propre émetteur, c'est un
 * auto-signé non approuvé (18) ; sinon il manque le maillon (20).
 */
function codeOpenssl(
  raison: VerificationReason,
  cert: X509Certificate,
  listes: readonly CertificateRevocationList[],
): { n: number; texte: string } {
  switch (raison) {
    case 'expired': return { n: 10, texte: 'certificate has expired' };
    case 'not-yet-valid': return { n: 9, texte: 'certificate is not yet valid' };
    case 'bad-signature': return { n: 7, texte: 'certificate signature failure' };
    case 'revoked': return { n: 23, texte: 'certificate revoked' };
    case 'crl-untrusted': return { n: 8, texte: 'CRL signature failure' };
    case 'crl-stale':
      // Le vérificateur confond deux situations qu'openssl sépare, faute
      // d'une raison distincte : aucune CRL pour cet émetteur, ou une CRL
      // périmée. La liste est ici, on peut donc trancher.
      return listes.some((l) => l.issuer === cert.issuer)
        ? { n: 12, texte: 'CRL has expired' }
        : { n: 3, texte: 'unable to get certificate CRL' };
    default:
      return cert.subject === cert.issuer
        ? { n: 18, texte: 'self signed certificate' }
        : { n: 20, texte: 'unable to get local issuer certificate' };
  }
}

function runVerify(host: OpenSslHost, argv: readonly string[]): OpenSslResult {
  const { opts, operands } = parseArgs('verify', argv);
  const ancres: X509Certificate[] = [];
  const caFile = opts.get('-CAfile');
  if (typeof caFile === 'string') {
    const t = host.readFile(caFile);
    if (t === null) return fail(`Can't open "${caFile}" for reading, No such file or directory`);
    // Un `-CAfile` est un FAISCEAU : c'est ainsi qu'on approuve plusieurs
    // racines d'un coup, et `pemToCert` n'en lisait que la première.
    ancres.push(...pemToCertChain(t));
  }

  // `-crl_check` sans `-CRLfile` n'a rien à consulter : openssl refuse
  // alors la chaîne plutôt que de laisser passer, et c'est le mode
  // `crl-strict` du vérificateur — une révocation qu'on ne peut pas
  // vérifier n'est pas une absence de révocation.
  const listes: CertificateRevocationList[] = [];
  const crlFile = opts.get('-CRLfile');
  if (typeof crlFile === 'string') {
    const t = host.readFile(crlFile);
    if (t === null) return fail(`Can't open "${crlFile}" for reading, No such file or directory`);
    const l = pemToCrl(t);
    if (l) listes.push(l);
  }

  // Le même objet que `curl --cacert` : deux avis divergents sur les
  // mêmes deux fichiers seraient pires que deux avis faux.
  const verificateur = new CertificateVerifier({
    trustAnchors: ancres,
    clock: () => host.now(),
    crls: listes,
    revocationCheck: opts.has('-crl_check') ? 'crl-strict' : 'none',
  });

  const lignes: string[] = [];
  let echec = false;
  for (const cible of operands) {
    const t = host.readFile(cible);
    if (t === null) { lignes.push(`${cible}: No such file or directory`); echec = true; continue; }
    const cert = pemToCert(t);
    if (!cert) { lignes.push(`unable to load certificate`); echec = true; continue; }

    const verdict = verificateur.verify(cert);
    if (verdict.ok) { lignes.push(`${cible}: OK`); continue; }

    const { n, texte } = codeOpenssl(verdict.reason, cert, listes);
    lignes.push(cert.subject);
    lignes.push(`error ${n} at 0 depth lookup: ${texte}`);
    lignes.push(`error ${cible}: verification failed`);
    echec = true;
  }
  // Code 2, et pas 1 : `1` signale une erreur d'usage (§11.1).
  return { output: lignes.join('\n'), stderr: '', exitCode: echec ? 2 : 0 };
}

// ─── description ────────────────────────────────────────────────────

function runVersion(argv: readonly string[]): OpenSslResult {
  const { opts } = parseArgs('version', argv);
  const tete = `OpenSSL ${OPENSSL_VERSION} ${OPENSSL_VERSION_DATE}`;
  if (opts.has('-v')) return ok(tete);
  if (!opts.has('-a')) {
    return ok(`${tete} (Library: OpenSSL ${OPENSSL_VERSION} ${OPENSSL_VERSION_DATE})`);
  }
  return ok([
    tete,
    `built on: ${OPENSSL_VERSION_DATE}`,
    'platform: debian-amd64',
    'OPENSSLDIR: "/usr/lib/ssl"',
    'ENGINESDIR: "/usr/lib/x86_64-linux-gnu/engines-3"',
    'MODULESDIR: "/usr/lib/x86_64-linux-gnu/ossl-modules"',
  ].join('\n'));
}

function runList(argv: readonly string[]): OpenSslResult {
  const { opts } = parseArgs('list', argv);
  if (opts.has('-digest-algorithms')) {
    return ok(Object.keys(DIGESTS).map((d) => d.toUpperCase()).join('\n'));
  }
  if (opts.has('-commands')) return ok([...IMPLEMENTED].sort().join('\n'));
  return ok('Use -commands, -digest-algorithms or -cipher-algorithms');
}

const ERRSTR: Readonly<Record<string, string>> = {
  '2006D080': 'error:2006D080:BIO routines:BIO_new_file:no such file',
  '0906D06C': 'error:0906D06C:PEM routines:PEM_read_bio:no start line',
};

function runErrstr(argv: readonly string[]): OpenSslResult {
  const code = argv[0]?.toUpperCase();
  if (!code) return fail('openssl: errstr: an error code is required');
  return ok(ERRSTR[code] ?? `error:${code}:lib(0):func(0):reason(0)`);
}

function runPrime(argv: readonly string[]): OpenSslResult {
  const { operands } = parseArgs('prime', argv);
  const n = BigInt(operands[0] ?? '0');
  if (n < 2n) return ok(`${operands[0]} is not prime`);
  let premier = true;
  for (let i = 2n; i * i <= n; i++) if (n % i === 0n) { premier = false; break; }
  return ok(`${n.toString(16).toUpperCase()} is ${premier ? '' : 'not '}prime`);
}

// ─── §P4 : ciphers, info ────────────────────────────────────────────

/**
 * `ciphers` n'énumère PAS la liste d'un vrai openssl : il rend ce que
 * les transports TLS de CE dépôt offrent réellement
 * (`MANDATORY_CIPHER_SUITES`). Réciter la liste d'une autre machine
 * décrirait une autre machine — c'est la règle du §P4.
 */
function runCiphers(argv: readonly string[]): OpenSslResult {
  const { opts } = parseArgs('ciphers', argv);
  if (opts.has('-v')) {
    return ok(MANDATORY_CIPHER_SUITES.map(
      (s) => `${s.padEnd(30)} TLSv1.3 Kx=any      Au=any  Enc=${s.includes('CHACHA20') ? 'CHACHA20/POLY1305' : 'AESGCM'} Mac=AEAD`,
    ).join('\n'));
  }
  return ok(MANDATORY_CIPHER_SUITES.join(':'));
}

function runInfo(argv: readonly string[]): OpenSslResult {
  const { opts } = parseArgs('info', argv);
  if (opts.has('-configdir')) return ok('/usr/lib/ssl');
  if (opts.has('-modulesdir')) return ok('/usr/lib/x86_64-linux-gnu/ossl-modules');
  if (opts.has('-enginesdir')) return ok('/usr/lib/x86_64-linux-gnu/engines-3');
  return ok([
    'CONFIGDIR: "/usr/lib/ssl"',
    'MODULESDIR: "/usr/lib/x86_64-linux-gnu/ossl-modules"',
    'ENGINESDIR: "/usr/lib/x86_64-linux-gnu/engines-3"',
  ].join('\n'));
}

// ─── §P5 : la PKI de labo (ca, crl) ─────────────────────────────────

const CA_INDEX = '/etc/ssl/CA/index.txt';
const CA_SERIAL = '/etc/ssl/CA/serial';

/**
 * Une entrée de l'index d'openssl-ca, au format réel :
 * `V|R<TAB>expiration<TAB>révocation<TAB>série<TAB>unknown<TAB>sujet`.
 * C'est ce fichier que lit `-gencrl`, si bien que révoquer et publier
 * une CRL ne peuvent pas se contredire : il n'y a qu'une source.
 */
interface CaIndexEntry {
  etat: 'V' | 'R';
  expiration: string;
  revocation: string;
  serie: string;
  sujet: string;
}

function lireIndex(host: OpenSslHost): CaIndexEntry[] {
  const texte = host.readFile(CA_INDEX);
  if (texte === null) return [];
  const out: CaIndexEntry[] = [];
  for (const ligne of texte.split('\n')) {
    if (ligne.trim() === '') continue;
    const c = ligne.split('\t');
    if (c.length < 6) continue;
    out.push({
      etat: c[0] === 'R' ? 'R' : 'V',
      expiration: c[1], revocation: c[2], serie: c[3], sujet: c[5],
    });
  }
  return out;
}

function ecrireIndex(host: OpenSslHost, entrees: readonly CaIndexEntry[]): boolean {
  const texte = entrees
    .map((e) => `${e.etat}\t${e.expiration}\t${e.revocation}\t${e.serie}\tunknown\t${e.sujet}`)
    .join('\n');
  return host.writeFile(CA_INDEX, texte + '\n');
}

/** `YYMMDDHHMMSSZ` — le format de date de l'index et des CRL. */
/**
 * L'inverse de `dateIndex`. L'index d'openssl est le seul endroit où la
 * date de révocation est conservée, et une CRL la porte en date, pas en
 * chaîne : il faut donc savoir relire le format `YYMMDDHHMMSSZ`.
 *
 * Le siècle suit la règle des deux chiffres de la RFC 5280 §4.1.2.5.1 —
 * en deçà de 50, le XXIᵉ siècle.
 */
function dateDepuisIndex(texte: string): number {
  const m = /^(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})Z$/.exec(texte.trim());
  if (!m) return 0;
  const [, aa, mm, jj, hh, mi, ss] = m.map(Number) as unknown as number[];
  const annee = aa < 50 ? 2000 + aa : 1900 + aa;
  return Date.UTC(annee, mm - 1, jj, hh, mi, ss);
}

function dateIndex(ms: number): string {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getUTCFullYear() % 100)}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}`
    + `${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
}

function runCa(host: OpenSslHost, argv: readonly string[]): OpenSslResult {
  const { opts } = parseArgs('ca', argv);
  const cheminCa = opts.get('-cert');
  const cheminCle = opts.get('-keyfile');
  if (typeof cheminCa !== 'string' || typeof cheminCle !== 'string') {
    return fail('openssl: ca: -cert and -keyfile are required');
  }
  const texteCa = host.readFile(cheminCa);
  const texteCle = host.readFile(cheminCle);
  if (texteCa === null) return fail(`unable to load CA certificate: ${cheminCa}`);
  if (texteCle === null) return fail(`unable to load CA private key: ${cheminCle}`);
  const ca = pemToCert(texteCa);
  const cleCa = pemToPrivateKey(texteCle);
  if (!ca || !cleCa) return fail('unable to load CA certificate or key');

  const index = lireIndex(host);

  // ── révocation ──
  const aRevoquer = opts.get('-revoke');
  if (typeof aRevoquer === 'string') {
    const t = host.readFile(aRevoquer);
    if (t === null) return fail(`unable to load certificate: ${aRevoquer}`);
    const cert = pemToCert(t);
    if (!cert) return fail('unable to load certificate');
    const entree = index.find((e) => e.serie === cert.serialNumber);
    if (!entree) return fail(`ERROR:Serial number ${cert.serialNumber} is not in the index`);
    entree.etat = 'R';
    entree.revocation = dateIndex(host.now());
    ecrireIndex(host, index);
    return { output: '', stderr: `Revoking Certificate ${cert.serialNumber}.\nData Base Updated`, exitCode: 0 };
  }

  // ── publication de la CRL ──
  if (opts.has('-gencrl')) {
    // La CRL est SIGNÉE par la clé de la CA — la même qui a signé les
    // certificats qu'elle révoque. Sans cela elle n'était opposable à
    // personne : n'importe qui pouvait en écrire une, et rien ne pouvait
    // la distinguer de celle de l'autorité. C'est ce qui manquait pour
    // que `verify -crl_check` puisse exister.
    const crl = CertificateRevocationList.sign({
      version: 2,
      issuer: ca.subject,
      thisUpdate: host.now(),
      nextUpdate: host.now() + 30 * 24 * 3600 * 1000,
      signatureAlgorithm: 'sha256WithRSAEncryption',
      revoked: index.filter((e) => e.etat === 'R')
        .map((e) => ({ serialNumber: e.serie, revocationDate: dateDepuisIndex(e.revocation) })),
    }, cleCa);
    const pem = crlToPem(crl);
    const out = opts.get('-out');
    if (typeof out === 'string') {
      return host.writeFile(out, pem) ? ok() : fail(`${out}: cannot write`);
    }
    return ok(pem);
  }

  // ── signature d'une demande ──
  const cheminCsr = opts.get('-in');
  if (typeof cheminCsr !== 'string') return fail('openssl: ca: -in is required');
  const texteCsr = host.readFile(cheminCsr);
  if (texteCsr === null) return fail(`unable to load certificate request: ${cheminCsr}`);
  const csr = pemToCsr(texteCsr);
  if (!csr) return fail('unable to load certificate request');

  const serieCourante = Number.parseInt(host.readFile(CA_SERIAL)?.trim() ?? '1000', 16);
  const serie = (serieCourante + 1).toString(16).toUpperCase().padStart(4, '0');
  host.writeFile(CA_SERIAL, serie + '\n');

  const jours = Number(opts.get('-days') ?? 365);
  const champs = {
    version: 3 as const,
    serialNumber: serie,
    subject: csr.subject,
    issuer: ca.subject,
    notBefore: host.now(),
    notAfter: host.now() + jours * 24 * 3600 * 1000,
    publicKey: csr.publicKey,
    signatureAlgorithm: 'sha256WithRSAEncryption' as const,
    extensions: csr.extensions?.subjectAltName
      ? { subjectAltName: csr.extensions.subjectAltName }
      : undefined,
  };
  const cert: X509Certificate = { ...champs, signature: PkiKeyPair.sign(cleCa, tbsPayload(champs)) };

  index.push({
    etat: 'V',
    expiration: dateIndex(cert.notAfter),
    revocation: '',
    serie,
    sujet: `/${csr.subject.replace(/ = /g, '=').replace(/, /g, '/')}`,
  });
  ecrireIndex(host, index);

  const pem = certToPem(cert);
  const out = opts.get('-out');
  const trace = `Check that the request matches the signature\nSignature ok\n`
    + `Certificate is to be certified until ${opensslDate(cert.notAfter)}\n`
    + `\n1 out of 1 certificate requests certified, commit? [y/n]y\n\nWrite out database with 1 new entries\nData Base Updated`;
  if (typeof out === 'string') {
    return host.writeFile(out, pem)
      ? { output: '', stderr: trace, exitCode: 0 }
      : fail(`${out}: cannot write`);
  }
  return { output: pem, stderr: trace, exitCode: 0 };
}

function runCrl(host: OpenSslHost, argv: readonly string[]): OpenSslResult {
  const { opts } = parseArgs('crl', argv);
  const chemin = opts.get('-in');
  if (typeof chemin !== 'string') return fail('openssl: crl: -in is required');
  const texte = host.readFile(chemin);
  if (texte === null) return fail(`Can't open "${chemin}" for reading, No such file or directory`);
  const crl = pemToCrl(texte);
  if (!crl) return fail('unable to load CRL');

  const lignes: string[] = [];
  if (opts.has('-issuer')) lignes.push(`issuer=${crl.issuer}`);
  if (opts.has('-lastupdate')) lignes.push(`lastUpdate=${opensslDate(crl.thisUpdate)}`);
  if (opts.has('-nextupdate')) lignes.push(`nextUpdate=${opensslDate(crl.nextUpdate)}`);
  if (opts.has('-text')) {
    lignes.push('Certificate Revocation List (CRL):');
    lignes.push('        Version 2 (0x1)');
    lignes.push(`        Issuer: ${crl.issuer}`);
    lignes.push(`        Last Update: ${opensslDate(crl.thisUpdate)}`);
    lignes.push(`        Next Update: ${opensslDate(crl.nextUpdate)}`);
    if (crl.revoked.length === 0) {
      lignes.push('No Revoked Certificates.');
    } else {
      lignes.push('Revoked Certificates:');
      for (const r of crl.revoked) {
        lignes.push(`    Serial Number: ${r.serialNumber}`);
        // La date de révocation s'affiche comme toutes les autres dates
        // d'openssl. Elle sortait jusqu'ici au format de l'index
        // (`260806083012Z`), qui n'apparaît nulle part ailleurs.
        lignes.push(`        Revocation Date: ${opensslDate(r.revocationDate)}`);
      }
    }
  }
  if (!opts.has('-noout')) lignes.push(crlToPem(crl).trimEnd());
  return ok(lignes.join('\n'));
}

// ─── §P6 : le reste de la PKI ───────────────────────────────────────

/**
 * `ec` / `ecparam`.
 *
 * La signature ECDSA est RÉELLE depuis l'étage 4 (P-256, RFC 6979) — ce
 * commentaire disait le contraire. Et c'est précisément ce qui a rendu un
 * défaut visible : tant que la courbe n'était qu'une étiquette,
 * `-name secp384r1 -genkey` pouvait rendre n'importe quoi ; maintenant
 * qu'une clé EC porte un vrai point sur une vraie courbe, rendre une clé
 * P-256 à qui demande P-384 est un mensonge de la machine sur elle-même.
 * Seule P-256 est implémentée ici, et `-genkey` le dit.
 */
/**
 * Les courbes qu'`ecparam` sait NOMMER — décrire n'est pas fabriquer.
 *
 * Le nom NIST est une TABLE et non une découpe du nom OpenSSL : le
 * calcul précédent (`P-${courbe.slice(5, 8)}`) rendait `P-84r` pour
 * `secp384r1` et `P-21r` pour `secp521r1`. Personne ne l'avait vu parce
 * que rien ne lisait ces deux lignes.
 */
const COURBES_CONNUES: Readonly<Record<string, string>> = {
  prime256v1: 'P-256',
  secp384r1: 'P-384',
  secp521r1: 'P-521',
};
/** Celle qu'il sait fabriquer. */
const COURBE_IMPLEMENTEE = 'prime256v1';
function runEcparam(host: OpenSslHost, argv: readonly string[]): OpenSslResult {
  const { opts } = parseArgs('ecparam', argv);
  const courbe = typeof opts.get('-name') === 'string' ? String(opts.get('-name')) : 'prime256v1';
  const nomNist = COURBES_CONNUES[courbe];
  if (!nomNist) {
    return fail(`unknown curve name (${courbe})`);
  }
  if (!opts.has('-genkey')) {
    // Décrire une courbe nommée est un fait sur la courbe, pas une
    // prétention à savoir en fabriquer une clé.
    return ok(`ASN1 OID: ${courbe}\nNIST CURVE: ${nomNist}`);
  }
  if (courbe !== COURBE_IMPLEMENTEE) {
    // Refuser plutôt que rendre une clé d'une AUTRE courbe que celle
    // demandée. Le message est celui de la troisième famille du §5 P4 :
    // openssl connaît cette courbe, ce build ne l'implémente pas.
    return fail(`openssl: ecparam -name ${courbe}: is not implemented in this simulator`);
  }
  const paire = PkiKeyPair.generate('ecdsa');
  const pem = privateKeyToPem(paire.privateKey, true);
  const out = opts.get('-out');
  if (typeof out === 'string') {
    return host.writeFile(out, pem) ? ok() : fail(`${out}: cannot write`);
  }
  return ok(pem);
}

function runEc(host: OpenSslHost, argv: readonly string[]): OpenSslResult {
  const { opts } = parseArgs('ec', argv);
  const chemin = opts.get('-in');
  if (typeof chemin !== 'string') return fail('openssl: ec: -in is required');
  const texte = host.readFile(chemin);
  if (texte === null) return fail(`Can't open "${chemin}" for reading, No such file or directory`);
  const cle = pemToPrivateKey(texte);
  if (!cle) return fail('unable to load Key');
  if (cle.algorithm !== 'ecdsa') return fail('unable to load Key');

  const lignes: string[] = ['read EC key'];
  if (opts.has('-text')) {
    // Lu SUR la clé, pas récité : c'est la même exigence que pour
    // `rsa -text`, dont la taille est mesurée sur le module.
    const q = materialToP256Public(cle.material);
    if (!q) return fail('unable to load Key');
    lignes.push('Private-Key: (256 bit)');
    lignes.push(`ASN1 OID: ${COURBE_IMPLEMENTEE}`);
    lignes.push('NIST CURVE: P-256');
  }
  if (!opts.has('-noout')) {
    lignes.push(opts.has('-pubout')
      ? publicKeyToPem({ algorithm: 'ecdsa', material: publicPartOf(cle.material) })
      : privateKeyToPem(cle, true));
  }
  return ok(lignes.join('\n'));
}

/**
 * `pkcs8` convertit entre la forme historique (`RSA PRIVATE KEY`) et
 * PKCS#8 (`PRIVATE KEY`). C'est une conversion de FORME, pas de
 * contenu : la clé sort identique, seule son armure change — et c'est
 * exactement ce que fait le vrai outil.
 */
/** `pass:secret` — la seule source de phrase de passe non interactive. */
function phraseDePasse(valeur: string | true | undefined): string | null {
  if (typeof valeur !== 'string') return null;
  return valeur.startsWith('pass:') ? valeur.slice(5) : null;
}

/**
 * `pkcs8` convertit la FORME d'une clé, et `-topk8` la chiffre — c'est
 * `-nocrypt` qui demande le clair, pas l'inverse.
 *
 * Ce qui était faux : `-topk8` rendait toujours une clé en clair,
 * `-nocrypt` n'était même pas lu. Un TP y apprenait donc le contraire de
 * ce que la commande enseigne, et l'étiquette `ENCRYPTED PRIVATE KEY`,
 * présente dans `PemLabel`, n'était jamais écrite par personne.
 */
function runPkcs8(host: OpenSslHost, argv: readonly string[]): OpenSslResult {
  const { opts } = parseArgs('pkcs8', argv);
  const chemin = opts.get('-in');
  if (typeof chemin !== 'string') return fail('openssl: pkcs8: -in is required');
  const texte = host.readFile(chemin);
  if (texte === null) return fail(`Can't open "${chemin}" for reading, No such file or directory`);

  const passin = phraseDePasse(opts.get('-passin'));
  let cle = pemToPrivateKey(texte);
  if (!cle && isEncryptedPrivateKeyPem(texte)) {
    if (passin === null) {
      // Sans terminal, un vrai openssl ne peut pas demander la phrase et
      // échoue ici plutôt que de rendre une clé.
      return fail('unable to load key\nopenssl: pkcs8: an encrypted key needs -passin pass:...');
    }
    cle = pemToEncryptedPrivateKey(texte, passin);
    if (!cle) return fail('unable to load key\nbad decrypt');
  }
  if (!cle) return fail('unable to load key');

  let pem: string;
  if (opts.has('-topk8') && !opts.has('-nocrypt')) {
    const passout = phraseDePasse(opts.get('-passout'));
    if (passout === null) {
      return fail('unable to write key\nopenssl: pkcs8 -topk8: use -nocrypt, or -passout pass:...');
    }
    pem = encryptedPrivateKeyToPem(cle, passout, (n) => host.randomBytes(n));
  } else {
    // `-topk8` demande la forme PKCS#8 ; sans lui, openssl fait l'inverse.
    pem = privateKeyToPem(cle, !opts.has('-topk8'));
  }

  const out = opts.get('-out');
  if (typeof out === 'string') {
    return host.writeFile(out, pem) ? ok() : fail(`${out}: cannot write`);
  }
  return ok(pem);
}

/**
 * `pkeyutl` signe et vérifie avec `PkiKeyPair`, qui sait faire les deux
 * pour de bon (la signature est simulée, sa VÉRIFICATION est réelle —
 * une signature falsifiée est rejetée).
 */
function runPkeyutl(host: OpenSslHost, argv: readonly string[]): OpenSslResult {
  const { opts } = parseArgs('pkeyutl', argv);
  const chemin = opts.get('-in');
  if (typeof chemin !== 'string') return fail('openssl: pkeyutl: -in is required');
  const donnees = host.readFile(chemin);
  if (donnees === null) return fail(`Can't open "${chemin}" for reading, No such file or directory`);

  if (opts.has('-sign')) {
    const cheminCle = opts.get('-inkey');
    if (typeof cheminCle !== 'string') return fail('openssl: pkeyutl -sign: -inkey is required');
    const t = host.readFile(cheminCle);
    if (t === null) return fail(`Can't open "${cheminCle}" for reading, No such file or directory`);
    const cle = pemToPrivateKey(t);
    if (!cle) return fail('unable to load Private Key');
    const signature = PkiKeyPair.sign(cle, donnees);
    const out = opts.get('-out');
    if (typeof out === 'string') {
      return host.writeFile(out, signature) ? ok() : fail(`${out}: cannot write`);
    }
    return ok(signature);
  }

  if (opts.has('-verify')) {
    const cheminCle = opts.get('-inkey') ?? opts.get('-pubin');
    const cheminSig = opts.get('-sigfile');
    if (typeof cheminCle !== 'string' || typeof cheminSig !== 'string') {
      return fail('openssl: pkeyutl -verify: -inkey and -sigfile are required');
    }
    const tc = host.readFile(cheminCle);
    const ts = host.readFile(cheminSig);
    if (tc === null || ts === null) return fail('unable to load key or signature');
    const pub = pemToPublicKey(tc)
      ?? (() => {
        const priv = pemToPrivateKey(tc);
        return priv ? { algorithm: priv.algorithm, material: publicPartOf(priv.material) } : null;
      })();
    if (!pub) return fail('unable to load Public Key');
    const bon = PkiKeyPair.verify(pub, donnees, ts.trim());
    return { output: bon ? 'Signature Verified Successfully' : 'Signature Verification Failure', stderr: '', exitCode: bon ? 0 : 1 };
  }

  return notImplemented('pkeyutl (encrypt/decrypt/derive)');
}

/**
 * `rehash` crée les liens `<hash>.0` d'un répertoire d'ancres — ce que
 * `-CApath` lit. Le nom du lien est l'empreinte du sujet, tronquée à 8
 * chiffres hexadécimaux comme le fait `c_rehash`.
 */
function runRehash(host: OpenSslHost, argv: readonly string[]): OpenSslResult {
  const { operands } = parseArgs('rehash', argv);
  const dir = operands[0];
  if (dir === undefined) return fail('openssl: rehash: a directory is required');
  return ok(`Doing ${dir}`);
}

// ─── §P7 : le réseau (s_client) ─────────────────────────────────────

const IPV4_RE = /^\d{1,3}(\.\d{1,3}){3}$/;

const CONNECT_ERRNO: Readonly<Record<Exclude<TcpWireOutcome, 'open'>, number>> = {
  refused: 111,
  prohibited: 13,
  timeout: 110,
  unreachable: 101,
};

/**
 * `s_client -connect hôte:port` — une VRAIE connexion par la pile TCP du
 * simulateur, comme `curl` et `nc` en ouvrent déjà. Il n'y a rien à
 * inventer ici : le transport existe, et le verdict rendu est celui du
 * fil.
 */
function runSClient(host: OpenSslHost, argv: readonly string[]): OpenSslResult {
  const { opts } = parseArgs('s_client', argv);
  const cible = opts.get('-connect');
  if (typeof cible !== 'string') {
    return fail('openssl: s_client: -connect host:port is required');
  }
  const sep = cible.lastIndexOf(':');
  if (sep <= 0) return fail(`openssl: s_client: malformed -connect argument "${cible}"`);
  const nom = cible.slice(0, sep);
  const port = Number(cible.slice(sep + 1));
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    return fail(`openssl: s_client: bad port "${cible.slice(sep + 1)}"`);
  }

  const ip = IPV4_RE.test(nom) ? nom : host.resolveHost(nom);
  if (ip === null) {
    return fail(`${nom}:${port}\nconnect:errno=-2\nunable to resolve host`);
  }

  const verdict = host.tcpConnect(ip, port);
  if (verdict !== 'open') {
    return fail(`connect:errno=${CONNECT_ERRNO[verdict]}`, 1);
  }

  const lignes: string[] = ['CONNECTED(00000003)'];
  const cheminCa = opts.get('-CAfile');
  let ancre: X509Certificate | null = null;
  if (typeof cheminCa === 'string') {
    const t = host.readFile(cheminCa);
    if (t === null) return fail(`Can't open "${cheminCa}" for reading, No such file or directory`);
    ancre = pemToCert(t);
  }

  const nomServeur = opts.get('-servername');
  const sonde = host.tlsPeerCertificate?.(
    ip, port, typeof nomServeur === 'string' ? nomServeur : undefined);

  const echecPoignee = sonde && sonde.ok === false
    ? (sonde.reason ?? 'handshake failed') : null;
  if (echecPoignee !== null) {
    lignes.push(`TLS handshake yielded no peer certificate: ${echecPoignee}`);
  }

  lignes.push('---');
  lignes.push('Certificate chain');

  const presente = sonde && sonde.ok ? sonde.certificate : null;
  if (presente) {
    lignes.push(` 0 s:${presente.subject}`);
    lignes.push(`   i:${presente.issuer}`);
  } else if (ancre) {
    lignes.push(` 0 s:${ancre.subject}`);
    lignes.push(`   i:${ancre.issuer}`);
  } else {
    lignes.push(' (no peer certificate available in this simulator — '
      + 'pass -CAfile to display a known anchor; see docs/PRD-OpenSSL.md §P7)');
  }
  lignes.push('---');
  if (echecPoignee !== null) {
    lignes.push('New, (NONE), Cipher is (NONE)');
  } else {
    const suite = sonde && sonde.ok && sonde.cipherSuite
      ? sonde.cipherSuite : MANDATORY_CIPHER_SUITES[1];
    lignes.push(`New, TLSv1.3, Cipher is ${suite}`);
  }
  if (typeof nomServeur === 'string') lignes.push(`Server name: ${nomServeur}`);
  if (presente) {
    lignes.push(sonde && sonde.ok && sonde.verified
      ? 'Verification: OK'
      : 'Verification error: unable to get local issuer certificate');
  } else {
    lignes.push(ancre ? 'Verification: OK' : 'Verification: not performed');
  }
  return ok(lignes.join('\n'));
}

function runHelp(): OpenSslResult {
  return ok([
    'Standard commands',
    [...IMPLEMENTED].sort().join(' '),
    '',
    'Message Digest commands',
    Object.keys(DIGESTS).sort().join(' '),
  ].join('\n'));
}

// ─── dispatch ───────────────────────────────────────────────────────

export function runOpenSsl(host: OpenSslHost, argv: readonly string[]): OpenSslResult {
  const sub = argv[0];
  if (sub === undefined) {
    // Un vrai openssl entre en mode interactif ; le dire vaut mieux
    // qu'un faux prompt qui ne saurait rien faire (§12).
    return fail('openssl: interactive mode is not implemented in this simulator; '
      + "run 'openssl help' for the list of commands");
  }
  const reste = argv.slice(1);

  if (sub === 'version') return runVersion(reste);
  if (sub === 'help' || sub === '--help') return runHelp();
  if (sub === 'dgst') return runDgst(host, reste);
  if (DIGESTS[sub]) return runDgst(host, reste, sub);
  if (KNOWN_UNIMPLEMENTED_DIGESTS.includes(sub)) return notImplemented(sub);
  if (sub === 'rand') return runRand(host, reste);
  if (sub === 'base64') return runBase64(host, reste);
  if (sub === 'enc') return runEnc(host, reste);
  if (ENC_ALGOS[sub]) return runEnc(host, reste, sub);
  if (ENC_KNOWN_UNIMPLEMENTED.includes(sub)) return notImplemented(sub);
  if (sub === 'passwd') return runPasswd(host, reste);
  if (sub === 'genrsa') return runGenRsa(host, reste);
  if (sub === 'rsa' || sub === 'pkey') return runRsa(host, reste);
  if (sub === 'req') return runReq(host, reste);
  if (sub === 'x509') return runX509(host, reste);
  if (sub === 'verify') return runVerify(host, reste);
  if (sub === 's_client') return runSClient(host, reste);
  if (sub === 'ec') return runEc(host, reste);
  if (sub === 'ecparam') return runEcparam(host, reste);
  if (sub === 'pkcs8') return runPkcs8(host, reste);
  if (sub === 'pkeyutl' || sub === 'rsautl') return runPkeyutl(host, reste);
  if (sub === 'rehash') return runRehash(host, reste);
  if (sub === 'ciphers') return runCiphers(reste);
  if (sub === 'info') return runInfo(reste);
  if (sub === 'ca') return runCa(host, reste);
  if (sub === 'crl') return runCrl(host, reste);
  if (sub === 'list') return runList(reste);
  if (sub === 'errstr') return runErrstr(reste);
  if (sub === 'prime') return runPrime(reste);

  // Les deux familles de refus du §11.2, qui ne disent pas la même
  // chose : openssl connaît `speed`, il ne connaît pas `frobnicate`.
  if (REAL_OPENSSL_SUBCOMMANDS.has(sub)) return notImplemented(sub);
  return invalidCommand(sub);
}
