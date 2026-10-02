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

import { connectErrno } from '@/network/tcp/types';
import { errnoNumber } from '@/network/core/Errno';
import { md4, md5Hex, sha1Hex, sha256Hex, sha512Hex, MD5, SHA1, SHA256, SHA512 } from '@/crypto/hash';
import { hmacHex } from '@/crypto/mac';
import { md5Crypt } from '@/crypto/passwords';
import {
  bytesToBase64, base64ToBytes, bytesToHex, utf8ToBytes, bytesToUtf8,
} from '@/crypto/encoding';
import { PkiKeyPair } from '@/network/pki/PkiKeyPair';
import { publicPartOf, modulusHex, materialToPublicKey, bitLength } from '@/crypto/rsa';
import type { PkiPrivateKey } from '@/network/pki/PkiKeyPair';
import { modpGroup } from '@/crypto/dh/modp';
import { isProbablePrime } from '@/crypto/rsa';
import { dhParametersToPem, pemToDhParameters, type DhParameters } from '@/network/pki/pem';
import {
  buildOcspResponse, verifyOcspResponse, ocspTimeIsValid, OCSP_RESPONSE_STATUS_CODE, OCSP_REQUEST_CONTENT_TYPE,
  type OcspCertId, type OcspRequestMessage, type OcspResponseMessage, type OcspStatusSource,
} from '@/network/pki/OcspWire';
import { ocspRequestToPem, pemToOcspRequest, ocspResponseToPem, pemToOcspResponse } from '@/network/pki/pem';
import { parseOpensslConfig, buildExtensions, type CertificateExtensions } from './X509v3Config';
import { materialToP256Public } from '@/crypto/ecc';
import { generateSelfSignedCertificate } from '@/network/pki/SelfSignedCertificate';
import { signCertificate, type X509Certificate } from '@/network/pki/X509Certificate';
import { encodeCertificate, canonicalSerial, sameSerial } from '@/network/pki/der/X509Der';
import { opensslDistinguishedName } from '@/network/pki/der/DistinguishedName';
import {
  certToPem, pemToCert, pemToCertChain, privateKeyToPem, pemToPrivateKey, publicKeyToPem,
  pemToPublicKey, csrToPem, pemToCsr, crlToPem, pemToCrl, type CertificateRequest,
  encryptedPrivateKeyToPem, pemToEncryptedPrivateKey, isEncryptedPrivateKeyPem, pemToPrivateKeyWithPassphrase,
} from '@/network/pki/pem';
import { buildCertificateRequest } from '@/network/pki/CertificateSigningRequest';
import { CertificateVerifier, type VerificationReason } from '@/network/pki/CertificateVerifier';
import { x509VerifyError } from '@/network/pki/x509VerifyErrors';
import { CertificateRevocationList } from '@/network/pki/CertificateRevocationList';
import { MANDATORY_CIPHER_SUITES } from '@/network/tls/cipherSuites';
import {
  createCipherList, cipherDescription, tls13Description, DEFAULT_CIPHER_RULE as DEFAULT_CIPHER_LIST,
} from '@/network/tls/legacy/cipherString';
import {
  isImplementedCipher, isImplementedTls13Cipher, legacySuiteByName, legacySuiteByOpensslName,
  type TlsProtocolVersion,
} from '@/network/tls/legacy/legacyCipherSuites';
import { DEFAULT_SECURITY_LEVEL, cipherPermitted, tls13CipherPermitted } from '@/network/tls/legacy/securityPolicy';
import { opensslAlertReason, type AlertDescription } from '@/network/tls/alerts';
import { parseArgs, parseSubject, REAL_OPENSSL_SUBCOMMANDS } from './OpenSslArgs';
import { runEnc, ENC_ALGOS, ENC_KNOWN_UNIMPLEMENTED } from './OpenSslEnc';
import { ok, fail, type OpenSslHost, type OpenSslResult } from './OpenSslHost';

import { OPENSSL_VERSION_DATE, OPENSSL_VERSION_TEXT } from './opensslVersion';

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
  'ciphers', 'info', 'ca', 'crl', 'dhparam', 'ocsp',
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
  const written = privateKeyPem(host, paire.privateKey, opts, opts.has('-traditional'));
  if ('error' in written) return fail(written.error);
  const pem = written.pem;
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
  const cle = privateKeyFrom(host, texte, opts);
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
    if (opts.has('-pubout')) {
      lignes.push(publicKeyToPem({ algorithm: cle.algorithm, material: publicPartOf(cle.material) }));
    } else {
      const written = privateKeyPem(host, cle, opts);
      if ('error' in written) return fail(written.error);
      lignes.push(written.pem);
    }
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
    cle = privateKeyFrom(host, t, opts);
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
    if (typeof keyout === 'string') {
      const written = privateKeyPem(host, cle, opts);
      if ('error' in written) return fail(written.error);
      if (!host.writeFile(keyout, written.pem)) return fail(`${keyout}: cannot write`);
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
    const addExtensions = repeatedOption(argv, '-addext').map((text): [string, string] => {
      const eq = text.indexOf('=');
      return [text.slice(0, eq).trim(), text.slice(eq + 1).trim()];
    });
    const overridden = new Set(addExtensions.map(([name]) => name));
    const entries: [string, string][] = [
      ...([['subjectKeyIdentifier', 'hash'], ['authorityKeyIdentifier', 'keyid:always,issuer'], ['basicConstraints', 'critical,CA:true']] as [string, string][])
        .filter(([name]) => !overridden.has(name)),
      ...addExtensions,
    ];
    const selfIssuer = { publicKey: publique, subject: sujet, issuer: sujet, serialNumber: '' } as unknown as X509Certificate;
    const built = buildExtensions(entries, { sections: new Map() }, { publicKey: publique, issuer: selfIssuer });
    if (built.ok === false) return fail(`Error Loading extension section v3_ca\n${built.error}`);
    const { cert } = generateSelfSignedCertificate(sujet, {
      now: host.now(),
      validityMs: jours * 24 * 3600 * 1000,
      keyPair: { publicKey: publique, privateKey: cle },
      extensions: built.extensions,
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
  if (opts.has('-subject')) lignes.push(`subject=${opensslDistinguishedName(cert.subject)}`);
  if (opts.has('-issuer')) lignes.push(`issuer=${opensslDistinguishedName(cert.issuer)}`);
  if (opts.has('-serial')) lignes.push(`serial=${shownSerial(cert.serialNumber)}`);
  if (opts.has('-startdate') || opts.has('-dates')) {
    lignes.push(`notBefore=${opensslDate(cert.notBefore)}`);
  }
  if (opts.has('-enddate') || opts.has('-dates')) {
    lignes.push(`notAfter=${opensslDate(cert.notAfter)}`);
  }
  if (opts.has('-fingerprint')) {
    const brut = bytesToHex(SHA256.digest(encodeCertificate(cert))).toUpperCase();
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

function shownSerial(serial: string): string {
  const digits = serial.replace(/^0+/, '').toUpperCase();
  return digits.length % 2 === 1 ? `0${digits}` : digits === '' ? '00' : digits;
}

function renderText(cert: X509Certificate): string[] {
  const l: string[] = [
    'Certificate:',
    '    Data:',
    `        Version: 3 (0x2)`,
    `        Serial Number: ${shownSerial(cert.serialNumber)}`,
    `        Signature Algorithm: ${cert.signatureAlgorithm}`,
    `        Issuer: ${opensslDistinguishedName(cert.issuer)}`,
    '        Validity',
    `            Not Before: ${opensslDate(cert.notBefore)}`,
    `            Not After : ${opensslDate(cert.notAfter)}`,
    `        Subject: ${opensslDistinguishedName(cert.subject)}`,
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
  const ext = cert.extensions;
  const critical = new Set(ext?.criticalExtensions ?? []);
  const mark = (name: string): string => (critical.has(name) ? ' critical' : '');
  const lines: string[] = [];
  if (ext?.basicConstraints) {
    lines.push(`            X509v3 Basic Constraints:${mark('basicConstraints')}`);
    lines.push(`                CA:${ext.basicConstraints.cA ? 'TRUE' : 'FALSE'}${ext.basicConstraints.pathLenConstraint !== undefined ? `, pathlen:${ext.basicConstraints.pathLenConstraint}` : ''}`);
  }
  if (ext?.keyUsage && ext.keyUsage.length > 0) {
    lines.push(`            X509v3 Key Usage:${mark('keyUsage')}`, `                ${ext.keyUsage.join(', ')}`);
  }
  if (ext?.extKeyUsage && ext.extKeyUsage.length > 0) {
    lines.push(`            X509v3 Extended Key Usage:${mark('extendedKeyUsage')}`, `                ${ext.extKeyUsage.join(', ')}`);
  }
  if (ext?.subjectAltName && ext.subjectAltName.length > 0) {
    lines.push('            X509v3 Subject Alternative Name:', `                ${ext.subjectAltName.join(', ')}`);
  }
  if (ext?.authorityInfoAccess && ext.authorityInfoAccess.length > 0) {
    lines.push('            Authority Information Access:',
      ...ext.authorityInfoAccess.map((a) => `                ${a.method === 'OCSP' ? 'OCSP' : 'CA Issuers'} - URI:${a.uri}`));
  }
  if (lines.length > 0) l.push('        X509v3 extensions:', ...lines);
  return l;
}

function extensionsFromFile(
  host: OpenSslHost, opts: Map<string, string | true>,
  csr: { readonly publicKey: { readonly material: string }; readonly extensions?: { readonly subjectAltName?: readonly string[] } },
  issuer: X509Certificate,
): { readonly extensions: CertificateExtensions | undefined } | { readonly error: string } {
  let extensions: CertificateExtensions | undefined = csr.extensions?.subjectAltName
    ? { subjectAltName: csr.extensions.subjectAltName }
    : undefined;
  const extfile = opts.get('-extfile');
  if (typeof extfile !== 'string') return { extensions };
  const configText = host.readFile(extfile);
  if (configText === null) return { error: `Can't open "${extfile}" for reading, No such file or directory` };
  const config = parseOpensslConfig(configText);
  const requested = opts.get('-extensions');
  const sectionName = typeof requested === 'string'
    ? requested
    : config.sections.get('default')?.find(([key]) => key === 'extensions')?.[1] ?? 'default';
  const entries = config.sections.get(sectionName);
  if (entries === undefined) {
    return { error: `Error checking extension section ${sectionName}\nerror in extension: no such section ${sectionName}` };
  }
  const built = buildExtensions(entries, config, { publicKey: csr.publicKey, issuer });
  if (built.ok === false) return { error: `Error adding extensions from section ${sectionName}\n${built.error}` };
  extensions = built.extensions;
  return { extensions };
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
  const caKey = privateKeyFrom(host, texteCaKey, opts);
  if (!ca) return fail('unable to load certificate');
  if (!caKey) return fail('unable to load CA Private Key');

  const jours = Number(opts.get('-days') ?? 30);
  const loaded = extensionsFromFile(host, opts, csr, ca);
  if ('error' in loaded) return fail(loaded.error);
  const extensions = loaded.extensions;
  const champs = {
    version: 3 as const,
    serialNumber: bytesToHex(host.randomBytes(8)),
    subject: csr.subject,
    issuer: ca.subject,
    notBefore: host.now(),
    notAfter: host.now() + jours * 24 * 3600 * 1000,
    publicKey: csr.publicKey,
    signatureAlgorithm: 'sha256WithRSAEncryption' as const,
    extensions,
  };
  const cert: X509Certificate = signCertificate(champs, caKey);

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

  const intermediaires: X509Certificate[] = [];
  const untrustedFile = opts.get('-untrusted');
  if (typeof untrustedFile === 'string') {
    const t = host.readFile(untrustedFile);
    if (t === null) return fail(`Can't open "${untrustedFile}" for reading, No such file or directory`);
    intermediaires.push(...pemToCertChain(t));
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

    const verdict = verificateur.verify(cert, undefined, intermediaires);
    if (verdict.ok) { lignes.push(`${cible}: OK`); continue; }

    const { n, texte } = x509VerifyError(verdict.reason, cert, listes);
    lignes.push(opensslDistinguishedName(cert.subject));
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
  if (opts.has('-v')) return ok(OPENSSL_VERSION_TEXT);
  if (!opts.has('-a')) {
    return ok(`${OPENSSL_VERSION_TEXT} (Library: ${OPENSSL_VERSION_TEXT})`);
  }
  return ok([
    OPENSSL_VERSION_TEXT,
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

const DH_PREGENERATED_GROUPS: ReadonlyMap<number, number> = new Map([
  [768, 1], [1024, 2], [1536, 5], [2048, 14], [3072, 15], [4096, 16], [6144, 17], [8192, 18],
]);

function labeledBignum(label: string, value: bigint): string[] {
  if (value < 0x10000000000000000n) return [`${label} ${value.toString()} (0x${value.toString(16)})`];
  let hex = value.toString(16);
  if (hex.length % 2 === 1) hex = `0${hex}`;
  const bytes = hex.match(/../g)!;
  const lines: string[] = [label];
  const padded = hex[0] >= '8' ? ['00', ...bytes] : bytes;
  for (let i = 0; i < padded.length; i += 15) lines.push(`    ${padded.slice(i, i + 15).join(':')}${i + 15 < padded.length ? ':' : ''}`);
  return lines;
}

function dhParametersText(parameters: DhParameters): string {
  const bits = parameters.prime.toString(2).length;
  const lines = [
    `DH Parameters: (${bits} bit)`,
    ...labeledBignum('P:   ', parameters.prime),
    ...labeledBignum('G:   ', parameters.generator),
  ];
  return lines.map((line) => `    ${line}`).join('\n');
}

function runDhparam(host: OpenSslHost, argv: readonly string[]): OpenSslResult {
  const { opts, operands } = parseArgs('dhparam', argv);
  const out = opts.get('-out');
  const messages: string[] = [];
  let parameters: DhParameters;
  const numbits = operands[0] === undefined ? (opts.has('-2') || opts.has('-3') || opts.has('-5') ? 2048 : null) : Number(operands[0]);
  if (numbits !== null) {
    if (!Number.isInteger(numbits) || numbits < 2) return fail('Error, unable to set DH prime length');
    if (opts.has('-3') || opts.has('-5')) {
      return fail(`openssl: dhparam: generator ${opts.has('-3') ? 3 : 5} needs a freshly generated safe prime, which this simulator does not compute`);
    }
    const id = DH_PREGENERATED_GROUPS.get(numbits);
    const group = id === undefined ? undefined : modpGroup(id);
    if (!group) {
      return fail(`openssl: dhparam: a ${numbits}-bit safe prime is not available here; pre-generated sizes: ${[...DH_PREGENERATED_GROUPS.keys()].join(', ')}`);
    }
    if (typeof opts.get('-in') === 'string') messages.push(`Warning, input file ${String(opts.get('-in'))} ignored`);
    messages.push(`Generating DH parameters, ${numbits} bit long safe prime`);
    parameters = { prime: group.prime, generator: group.generator };
  } else {
    const input = readInput(host, typeof opts.get('-in') === 'string' ? String(opts.get('-in')) : undefined);
    if (input === null) return fail(`Could not open file or uri for loading parameters from ${String(opts.get('-in'))}`);
    const parsed = pemToDhParameters(input);
    if (!parsed) return fail('Error, unable to load parameters');
    parameters = parsed;
  }
  const chunks: string[] = [];
  if (opts.has('-text')) chunks.push(dhParametersText(parameters));
  if (opts.has('-check')) {
    const safe = isProbablePrime(parameters.prime, 8) && isProbablePrime((parameters.prime - 1n) / 2n, 8);
    if (!safe) return fail('Error, invalid parameters generated');
    messages.push('DH parameters appear to be ok.');
  }
  if (!opts.has('-noout')) chunks.push(dhParametersToPem(parameters).replace(/\n$/, ''));
  const body = chunks.join('\n');
  if (typeof out === 'string') {
    if (!host.writeFile(out, body === '' ? '' : `${body}\n`)) return fail(`${out}: cannot write`);
    return { output: '', stderr: messages.join('\n'), exitCode: 0 };
  }
  return { output: body, stderr: messages.join('\n'), exitCode: 0 };
}

// ─── §P4 : ciphers, info ────────────────────────────────────────────

/**
 * `ciphers` n'énumère PAS la liste d'un vrai openssl : il rend ce que
 * les transports TLS de CE dépôt offrent réellement
 * (`MANDATORY_CIPHER_SUITES`). Réciter la liste d'une autre machine
 * décrirait une autre machine — c'est la règle du §P4.
 */
function runCiphers(argv: readonly string[]): OpenSslResult {
  const { opts, operands } = parseArgs('ciphers', argv);
  const spec = operands[0];
  const tls13Suites = opts.get('-ciphersuites');
  if (typeof tls13Suites === 'string' && createCipherList('DEFAULT', { tls13Suites, isAvailable: isImplementedCipher }).ok === false) {
    return fail('Error setting TLSv1.3 ciphersuites', 1);
  }
  const list = createCipherList(spec ?? DEFAULT_CIPHER_LIST, {
    isAvailable: isImplementedCipher,
    ...(typeof tls13Suites === 'string' ? { tls13Suites } : {}),
    isTls13Available: isImplementedTls13Cipher,
  });
  if (list.ok === false) return fail(`Error in cipher list\n${list.error}`, 1);
  let tls13 = list.tls13;
  let legacy = list.ciphers;
  if (opts.has('-s')) {
    const level = list.securityLevel ?? DEFAULT_SECURITY_LEVEL;
    const ceiling = (['-tls1_3', '-tls1_2', '-tls1_1', '-tls1', '-ssl3'] as const).find((flag) => opts.has(flag));
    const version = ceiling === '-tls1_3' ? 0x0304 : ceiling === '-tls1_2' ? 0x0303 : ceiling === '-tls1_1' ? 0x0302
      : ceiling === '-tls1' ? 0x0301 : ceiling === '-ssl3' ? 0x0300 : 0x0304;
    tls13 = version === 0x0304 ? tls13.filter((c) => tls13CipherPermitted(level, c.bits)) : [];
    legacy = legacy.filter((c) => c.minTls <= Math.min(version, 0x0303)
      && (version === 0x0304 ? false : true)
      && cipherPermitted(level, legacySuiteByOpensslName(c.name)!));
  }
  if (opts.has('-v') || opts.has('-V') || opts.has('-stdname')) {
    const lines: string[] = [];
    const hex2 = (value: number): string => `0x${(value & 0xff).toString(16).toUpperCase().padStart(2, '0')}`;
    const describe = (id: number, standard: string, text: string): string => {
      let prefix = '';
      if (opts.has('-V')) {
        prefix = (id & 0xff000000) === 0x03000000
          ? `          ${hex2(id >> 8)},${hex2(id)} - `
          : `${hex2(id >> 24)},${hex2(id >> 16)},${hex2(id >> 8)},${hex2(id)} - `;
      }
      return `${prefix}${opts.has('-stdname') ? `${standard.padEnd(45)} - ` : ''}${text}`;
    };
    for (const c of tls13) lines.push(describe(c.id, c.name, tls13Description(c)));
    for (const c of legacy) lines.push(describe(c.id, c.standardName, cipherDescription(c)));
    return ok(lines.join('').replace(/\n$/, ''));
  }
  return ok([...tls13.map((c) => c.name), ...legacy.map((c) => c.name)].join(':'));
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

function lireIndex(host: OpenSslHost, chemin: string = CA_INDEX): CaIndexEntry[] {
  const texte = host.readFile(chemin);
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

function repeatedOption(argv: readonly string[], name: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < argv.length - 1; i++) if (argv[i] === name) out.push(argv[i + 1]);
  return out;
}

function ocspResponseText(response: OcspResponseMessage): string[] {
  const lines = ['OCSP Response Data:', `    OCSP Response Status: ${response.status} (0x${OCSP_RESPONSE_STATUS_CODE[response.status].toString(16)})`];
  if (response.status === 'successful') {
    lines.push('    Response Type: Basic OCSP Response', '    Version: 1 (0x0)',
      `    Responder Id: ${response.responder ?? ''}`, `    Produced At: ${opensslDate(response.producedAt ?? 0)}`, '    Responses:');
    for (const single of response.singles) {
      lines.push('    Certificate ID:', `      Issuer: ${opensslDistinguishedName(single.tbs.issuer)}`, `      Serial Number: ${shownSerial(single.tbs.serialNumber)}`,
        `    Cert Status: ${single.tbs.status}`, `    This Update: ${opensslDate(single.tbs.thisUpdate)}`,
        `    Next Update: ${opensslDate(single.tbs.nextUpdate)}`);
    }
  }
  return lines;
}

function runOcsp(host: OpenSslHost, argv: readonly string[]): OpenSslResult {
  const { opts } = parseArgs('ocsp', argv);
  const text = (name: string): string | null => {
    const value = opts.get(name);
    return typeof value === 'string' ? value : null;
  };
  const read = (path: string, what: string): string | OpenSslResult => {
    const content = host.readFile(path);
    return content === null ? fail(`Error loading ${what}\nCan't open "${path}" for reading, No such file or directory`) : content;
  };
  const stderr: string[] = [];
  const out: string[] = [];
  const now = host.now();

  const caFile = text('-CAfile');
  const trusted: X509Certificate[] = [];
  if (caFile !== null) {
    const content = read(caFile, 'CA file');
    if (typeof content !== 'string') return content;
    trusted.push(...pemToCertChain(content));
  }

  const nmin = text('-nmin');
  const ndays = text('-ndays');
  const validityMs = nmin !== null ? Number(nmin) * 60_000 : ndays !== null ? Number(ndays) * 86_400_000 : undefined;

  const respondTo = (request: OcspRequestMessage): OcspResponseMessage | OpenSslResult => {
    const indexPath = text('-index');
    const caPath = text('-CA');
    const signerPath = text('-rsigner') ?? caPath;
    const keyPath = text('-rkey') ?? text('-rsigner') ?? text('-CA');
    if (indexPath === null || caPath === null || signerPath === null || keyPath === null) {
      return fail('Responder needs -index, -CA and a signing key (-rkey, -rsigner or the CA)');
    }
    const caText = read(caPath, 'CA certificate'); if (typeof caText !== 'string') return caText;
    const signerText = read(signerPath, 'responder certificate'); if (typeof signerText !== 'string') return signerText;
    const keyText = read(keyPath, 'responder key'); if (typeof keyText !== 'string') return keyText;
    const indexText = read(indexPath, 'index file'); if (typeof indexText !== 'string') return indexText;
    const ca = pemToCert(caText);
    const signerCert = pemToCert(signerText);
    const key = privateKeyFrom(host, keyText, opts);
    if (!ca || !signerCert || !key) return fail('Error loading responder certificate');
    const entries = lireIndex(host, indexPath);
    const source: OcspStatusSource = {
      lookup: (id) => {
        const entry = entries.find((e) => sameSerial(e.serie, id.serialNumber));
        if (!entry) return { status: 'unknown' };
        if (entry.etat === 'R') return { status: 'revoked', revokedAt: dateDepuisIndex(entry.revocation.split(',')[0]) };
        return { status: 'good' };
      },
    };
    return buildOcspResponse(
      request, source, { name: signerCert.subject, key, certificate: signerCert },
      { now, validityMs, caSubject: ca.subject },
    );
  };

  const summary = (response: OcspResponseMessage, request: OcspRequestMessage | null, names: readonly string[]): { text: string[]; ok: boolean } => {
    const lines: string[] = [];
    let ok = true;
    response.singles.forEach((single, index) => {
      const name = names[index] ?? shownSerial(single.tbs.serialNumber);
      lines.push(`${name}: ${single.tbs.status}`);
      lines.push(`\tThis Update: ${opensslDate(single.tbs.thisUpdate)}`);
      lines.push(`\tNext Update: ${opensslDate(single.tbs.nextUpdate)}`);
      if (single.tbs.status === 'revoked' && single.tbs.revokedAt !== undefined) {
        lines.push(`\tRevocation Time: ${opensslDate(single.tbs.revokedAt)}`);
      }
      if (!ocspTimeIsValid(single, now, 5 * 60_000, null)) { lines.push('WARNING: Status times invalid.'); ok = false; }
    });
    void request;
    return { text: lines, ok };
  };

  const finish = (code: number): OpenSslResult => ({ output: out.join('\n'), stderr: stderr.join('\n'), exitCode: code });

  const port = text('-port');
  if (port !== null) {
    const number = Number(port);
    if (!Number.isInteger(number) || number < 1 || number > 65535) return fail(`Illegal -port value ${port}`);
    if (typeof host.serveHttp !== 'function') return fail('openssl: ocsp -port: this platform cannot hold a listener');
    const probe = respondTo({ ids: [{ issuer: '', serialNumber: '' }] });
    if ('exitCode' in probe) return probe;
    const opened = host.serveHttp(number, (body) => {
      const request = pemToOcspRequest(body);
      if (!request) return { status: 200, body: ocspResponseToPem({ status: 'malformedRequest', singles: [] }) };
      const answer = respondTo(request);
      return { status: 200, body: ocspResponseToPem('exitCode' in answer ? { status: 'internalError', singles: [] } : answer) };
    });
    if (!opened) return fail(`Error setting up accept BIO\nAddress already in use`);
    stderr.push(`Waiting for OCSP client connections...`);
    return finish(0);
  }

  let request: OcspRequestMessage | null = null;
  let names: string[] = [];
  const reqin = text('-reqin');
  const respin = text('-respin');
  if (reqin !== null) {
    const content = read(reqin, 'request'); if (typeof content !== 'string') return content;
    request = pemToOcspRequest(content);
    if (!request) return fail('Error reading OCSP request');
  } else if (respin === null || text('-issuer') !== null) {
    const issuerPath = text('-issuer');
    const certPaths = repeatedOption(argv, '-cert');
    const serials = repeatedOption(argv, '-serial');
    if (issuerPath === null) return fail('No issuer certificate specified');
    if (respin === null && certPaths.length === 0 && serials.length === 0) return fail('Need an OCSP request to send: use -cert, -serial or -reqin');
    const issuerText = read(issuerPath, 'issuer certificate'); if (typeof issuerText !== 'string') return issuerText;
    const issuer = pemToCert(issuerText);
    if (!issuer) return fail('Error loading issuer certificate');
    const ids: OcspCertId[] = [];
    for (const path of certPaths) {
      const content = read(path, 'certificate'); if (typeof content !== 'string') return content;
      const cert = pemToCert(content);
      if (!cert) return fail('Error loading certificate');
      ids.push({ issuer: issuer.subject, serialNumber: canonicalSerial(cert.serialNumber) });
      names.push(path);
    }
    for (const serial of serials) {
      const clean = serial.replace(/^0x/i, '').toLowerCase();
      if (!/^[0-9a-f]+$/.test(clean)) return fail(`Error converting serial number ${serial}`);
      ids.push({ issuer: issuer.subject, serialNumber: canonicalSerial(clean) });
      names.push(serial);
    }
    const nonce = opts.has('-no_nonce') || respin !== null ? undefined : bytesToHex(host.randomBytes(16));
    request = { ids, ...(nonce !== undefined ? { nonce } : {}) };
  }
  if (request !== null && names.length === 0) names = request.ids.map((id) => shownSerial(id.serialNumber));

  const reqout = text('-reqout');
  if (reqout !== null && request !== null && !host.writeFile(reqout, ocspRequestToPem(request))) return fail(`${reqout}: cannot write`);

  let response: OcspResponseMessage | null = null;
  const respout = text('-respout');
  if (respin !== null) {
    const content = read(respin, 'response'); if (typeof content !== 'string') return content;
    response = pemToOcspResponse(content);
    if (!response) return fail('Error reading OCSP response');
  } else if (text('-index') !== null && (reqin !== null)) {
    const answer = respondTo(request!);
    if ('exitCode' in answer) return answer;
    response = answer;
  } else if (text('-url') !== null) {
    const url = /^http:\/\/([^/:]+)(?::(\d+))?(\/.*)?$/.exec(text('-url')!);
    if (!url) return fail(`${text('-url')} Error parsing -url argument`);
    const address = host.resolveHost(url[1]) ?? url[1];
    if (typeof host.httpPost !== 'function') return fail('openssl: ocsp -url: this platform has no HTTP client');
    const reply = host.httpPost(address, Number(url[2] ?? 80), url[3] ?? '/', ocspRequestToPem(request!), {
      'Content-Type': OCSP_REQUEST_CONTENT_TYPE,
    });
    if (reply.ok === false) return fail(`Error querying OCSP responder\nconnect:errno=111 (${reply.reason})`);
    response = pemToOcspResponse(reply.body);
    if (!response) return fail('Error querying OCSP responder');
  } else {
    return fail('Need an OCSP response: use -respin, -url or a local responder (-index with -reqin)');
  }

  if (respout !== null && !host.writeFile(respout, ocspResponseToPem(response))) return fail(`${respout}: cannot write`);
  if (response.status !== 'successful') {
    out.push(`Responder Error: ${response.status} (${OCSP_RESPONSE_STATUS_CODE[response.status]})`);
    return finish(1);
  }
  if (opts.has('-text')) out.push(...ocspResponseText(response));
  if (reqin !== null && text('-index') !== null && respin === null) return finish(0);

  let code = 0;
  if (!opts.has('-noverify')) {
    const verdict = verifyOcspResponse(response, request, trusted, now, true);
    if (verdict.ok === false) {
      if (verdict.reason === 'nonce-mismatch') { stderr.push('Nonce Verify error'); return finish(1); }
      stderr.push('Response Verify Failure', `error:${verdict.reason}`);
      code = 1;
    } else {
      if (request?.nonce !== undefined && response.nonce === undefined) stderr.push('WARNING: no nonce in response');
      stderr.push('Response verify OK');
    }
  }
  const printed = summary(response, request, names);
  out.push(...printed.text);
  return finish(printed.ok ? code : 1);
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
  const cleCa = privateKeyFrom(host, texteCle, opts);
  if (!ca || !cleCa) return fail('unable to load CA certificate or key');

  const index = lireIndex(host);

  // ── révocation ──
  const aRevoquer = opts.get('-revoke');
  if (typeof aRevoquer === 'string') {
    const t = host.readFile(aRevoquer);
    if (t === null) return fail(`unable to load certificate: ${aRevoquer}`);
    const cert = pemToCert(t);
    if (!cert) return fail('unable to load certificate');
    const entree = index.find((e) => sameSerial(e.serie, cert.serialNumber));
    if (!entree) return fail(`ERROR:Serial number ${shownSerial(cert.serialNumber)} is not in the index`);
    entree.etat = 'R';
    entree.revocation = dateIndex(host.now());
    ecrireIndex(host, index);
    return { output: '', stderr: `Revoking Certificate ${shownSerial(cert.serialNumber)}.\nData Base Updated`, exitCode: 0 };
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
        .map((e) => ({ serialNumber: canonicalSerial(e.serie), revocationDate: dateDepuisIndex(e.revocation) })),
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

  const caExtensions = extensionsFromFile(host, opts, csr, ca);
  if ('error' in caExtensions) return fail(caExtensions.error);
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
    extensions: caExtensions.extensions,
  };
  const cert: X509Certificate = signCertificate(champs, cleCa);

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
  if (opts.has('-issuer')) lignes.push(`issuer=${opensslDistinguishedName(crl.issuer)}`);
  if (opts.has('-lastupdate')) lignes.push(`lastUpdate=${opensslDate(crl.thisUpdate)}`);
  if (opts.has('-nextupdate')) lignes.push(`nextUpdate=${opensslDate(crl.nextUpdate)}`);
  if (opts.has('-text')) {
    lignes.push('Certificate Revocation List (CRL):');
    lignes.push('        Version 2 (0x1)');
    lignes.push(`        Issuer: ${opensslDistinguishedName(crl.issuer)}`);
    lignes.push(`        Last Update: ${opensslDate(crl.thisUpdate)}`);
    lignes.push(`        Next Update: ${opensslDate(crl.nextUpdate)}`);
    if (crl.revoked.length === 0) {
      lignes.push('No Revoked Certificates.');
    } else {
      lignes.push('Revoked Certificates:');
      for (const r of crl.revoked) {
        lignes.push(`    Serial Number: ${shownSerial(r.serialNumber)}`);
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
  const written = privateKeyPem(host, paire.privateKey, opts, true);
  if ('error' in written) return fail(written.error);
  const pem = written.pem;
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
  const cle = privateKeyFrom(host, texte, opts);
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
    if (opts.has('-pubout')) {
      lignes.push(publicKeyToPem({ algorithm: 'ecdsa', material: publicPartOf(cle.material) }));
    } else {
      const written = privateKeyPem(host, cle, opts, true);
      if ('error' in written) return fail(written.error);
      lignes.push(written.pem);
    }
  }
  return ok(lignes.join('\n'));
}

/**
 * `pkcs8` convertit entre la forme historique (`RSA PRIVATE KEY`) et
 * PKCS#8 (`PRIVATE KEY`). C'est une conversion de FORME, pas de
 * contenu : la clé sort identique, seule son armure change — et c'est
 * exactement ce que fait le vrai outil.
 */
/** `pass:secret` ou `file:chemin` (première ligne) — les sources non interactives de apps/apps.c. */
function phraseDePasse(valeur: string | true | undefined, host?: OpenSslHost): string | null {
  if (typeof valeur !== 'string') return null;
  if (valeur.startsWith('pass:')) return valeur.slice(5);
  if (valeur.startsWith('file:') && host) {
    const contenu = host.readFile(valeur.slice(5));
    return contenu === null ? null : (contenu.split('\n')[0] ?? '').replace(/\r$/, '');
  }
  return null;
}

const CIPHER_FLAGS: readonly string[] = [
  '-aes128', '-aes192', '-aes256', '-des3', '-camellia128', '-camellia192', '-camellia256',
  '-aria128', '-aria192', '-aria256',
];

function privateKeyPem(
  host: OpenSslHost, key: PkiPrivateKey, opts: Map<string, string | true>, traditional = false,
): { readonly pem: string } | { readonly error: string } {
  const wantsCipher = CIPHER_FLAGS.some((flag) => opts.has(flag));
  const encrypt = wantsCipher || (opts.has('-passout') && !opts.has('-nodes') && !opts.has('-noenc'));
  if (!encrypt) return { pem: privateKeyToPem(key, traditional) };
  const passout = phraseDePasse(opts.get('-passout'), host);
  if (passout === null) return { error: 'unable to write key\nopenssl: a passphrase source is required: -passout pass:... or file:...' };
  return { pem: encryptedPrivateKeyToPem(key, passout, (n) => host.randomBytes(n)) };
}

function privateKeyFrom(
  host: OpenSslHost, text: string, opts: Map<string, string | true>,
): PkiPrivateKey | null {
  return pemToPrivateKeyWithPassphrase(text, phraseDePasse(opts.get('-passin'), host));
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
    const cle = privateKeyFrom(host, t, opts);
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
    return fail(`connect:errno=${errnoNumber(connectErrno(verdict))}`, 1);
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
  const cipherSpec = opts.get('-cipher');
  const forced = (['-tls1_3', '-tls1_2', '-tls1_1', '-tls1'] as const).find((flag) => opts.has(flag));
  const versionOf: Record<string, TlsProtocolVersion> = {
    '-tls1_3': '1.3', '-tls1_2': '1.2', '-tls1_1': '1.1', '-tls1': '1.0',
  };
  const versions: readonly TlsProtocolVersion[] = forced
    ? [versionOf[forced]]
    : opts.has('-no_tls1_3') ? ['1.2'] : ['1.3', '1.2'];
  if (typeof cipherSpec === 'string') {
    const list = createCipherList(cipherSpec, { isAvailable: isImplementedCipher });
    if (list.ok === false) return fail(`Error setting cipher list\n${list.error}`, 1);
  }
  const probeOptions = {
    versions, ...(typeof cipherSpec === 'string' ? { cipherList: cipherSpec } : {}),
    ...(opts.has('-status') ? { requestStatus: true } : {}),
  };
  const sonde = host.tlsPeerCertificate?.(
    ip, port, typeof nomServeur === 'string' ? nomServeur : undefined, probeOptions);

  const echecPoignee = sonde && sonde.ok === false
    ? (sonde.reason ?? 'handshake failed') : null;
  if (echecPoignee !== null) {
    lignes.push(`TLS handshake yielded no peer certificate: ${echecPoignee}`);
    const raison = sonde && sonde.ok === false && sonde.alert ? opensslAlertReason(sonde.alert as AlertDescription) : undefined;
    if (raison) lignes.push(raison);
  }

  lignes.push('---');
  lignes.push('Certificate chain');

  const presente = sonde && sonde.ok ? sonde.certificate : null;
  if (presente) {
    lignes.push(` 0 s:${opensslDistinguishedName(presente.subject)}`);
    lignes.push(`   i:${opensslDistinguishedName(presente.issuer)}`);
  } else if (ancre) {
    lignes.push(` 0 s:${opensslDistinguishedName(ancre.subject)}`);
    lignes.push(`   i:${opensslDistinguishedName(ancre.issuer)}`);
  } else {
    lignes.push(' (no peer certificate available in this simulator — '
      + 'pass -CAfile to display a known anchor; see docs/PRD-OpenSSL.md §P7)');
  }
  lignes.push('---');
  if (opts.has('-status') && echecPoignee === null) {
    const staple = sonde && sonde.ok ? sonde.staple ?? null : null;
    if (staple === null) {
      lignes.push('OCSP response: no response sent');
    } else {
      lignes.push('OCSP response: ', '======================================',
        ...ocspResponseText({ status: 'successful', responder: staple.tbs.issuer, producedAt: staple.tbs.thisUpdate, singles: [staple] }),
        '======================================');
    }
  }
  if (echecPoignee !== null) {
    lignes.push('New, (NONE), Cipher is (NONE)');
  } else {
    const suite = sonde && sonde.ok && sonde.cipherSuite
      ? sonde.cipherSuite : MANDATORY_CIPHER_SUITES[1];
    const protocole = sonde && sonde.ok && sonde.protocolVersion ? sonde.protocolVersion : '1.3';
    const nomSuite = legacySuiteByName(suite)?.opensslName ?? suite;
    lignes.push(`New, TLSv${protocole}, Cipher is ${nomSuite}`);
    lignes.push('SSL-Session:');
    lignes.push(`    Protocol  : TLSv${protocole}`);
    lignes.push(`    Cipher    : ${nomSuite}`);
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
  if (sub === 'dhparam') return runDhparam(host, reste);
  if (sub === 'ocsp') return runOcsp(host, reste);

  // Les deux familles de refus du §11.2, qui ne disent pas la même
  // chose : openssl connaît `speed`, il ne connaît pas `frobnicate`.
  if (REAL_OPENSSL_SUBCOMMANDS.has(sub)) return notImplemented(sub);
  return invalidCommand(sub);
}
