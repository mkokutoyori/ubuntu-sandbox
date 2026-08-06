/**
 * docs/PRD-OpenSSL.md §5 P4 — les trois familles d'options.
 *
 * Reprise de `PRD-Curl` §P0, qui l'a éprouvée : une option implémentée
 * agit ; une option que le vrai openssl connaît et que ce build
 * n'implémente pas est refusée par un message explicite ; une option
 * qui n'existe nulle part est refusée avec le message du vrai openssl.
 *
 * Le message du milieu n'est volontairement PAS un message d'openssl :
 * aucun openssl réel n'est jamais dans cette situation, et répondre
 * « unknown option » pour une option qu'openssl connaît serait un
 * second mensonge.
 */

export interface ParsedArgs {
  /** Options nues (`-noout`) → true ; options à valeur (`-in f`) → la valeur. */
  readonly opts: Map<string, string | true>;
  /** Ce qui n'est pas une option : fichiers, tailles, noms. */
  readonly operands: string[];
}

/**
 * Les sous-commandes qu'un vrai openssl 3.x connaît. Sert à distinguer
 * « ce build ne l'implémente pas » de « ça n'existe pas », §11.2.
 */
export const REAL_OPENSSL_SUBCOMMANDS: ReadonlySet<string> = new Set([
  'asn1parse', 'ca', 'ciphers', 'cmp', 'cms', 'crl', 'crl2pkcs7', 'dgst', 'dhparam',
  'dsa', 'dsaparam', 'ec', 'ecparam', 'enc', 'engine', 'errstr', 'fipsinstall',
  'gendsa', 'genpkey', 'genrsa', 'help', 'info', 'kdf', 'list', 'mac', 'nseq',
  'ocsp', 'passwd', 'pkcs12', 'pkcs7', 'pkcs8', 'pkey', 'pkeyparam', 'pkeyutl',
  'prime', 'rand', 'rehash', 'req', 'rsa', 'rsautl', 's_client', 's_server',
  's_time', 'sess_id', 'smime', 'speed', 'spkac', 'srp', 'storeutl', 'ts',
  'verify', 'version', 'x509',
  // alias de hachage
  'md4', 'md5', 'sha1', 'sha224', 'sha256', 'sha384', 'sha512',
  'sha3-224', 'sha3-256', 'sha3-384', 'sha3-512', 'shake128', 'shake256',
  'blake2b512', 'blake2s256', 'rmd160', 'ripemd160', 'sm3',
  // alias de chiffrement
  'base64', 'aes-128-cbc', 'aes-192-cbc', 'aes-256-cbc', 'aes-128-ecb',
  'aes-192-ecb', 'aes-256-ecb', 'aes-128-gcm', 'aes-256-gcm', 'des', 'des3',
  'des-ede3', 'des-ede3-cbc', 'desx', 'rc2', 'rc4', 'chacha20',
  'chacha20-poly1305', 'seed', 'sm4-cbc', 'camellia-128-cbc', 'camellia-256-cbc',
  'aria-128-cbc', 'aria-256-cbc',
]);

/**
 * Les options qui prennent une valeur, par sous-commande. Sans cette
 * table, `-in fichier` verrait `fichier` comme un opérande et `-in`
 * comme un drapeau — le genre d'erreur qui ne se voit qu'au moment où
 * quelqu'un écrit `openssl x509 -in c.pem -noout`.
 */
const VALUED: Readonly<Record<string, readonly string[]>> = {
  '*': ['-in', '-out', '-keyout', '-key', '-passin', '-passout', '-pass', '-md', '-config'],
  dgst: ['-hmac', '-mac', '-macopt', '-sigopt', '-signature'],
  enc: ['-k', '-kfile', '-K', '-iv', '-S', '-iter'],
  passwd: ['-salt'],
  rand: ['-writerand'],
  genrsa: ['-passout'],
  genpkey: ['-algorithm', '-pkeyopt'],
  req: ['-days', '-subj', '-newkey', '-addext', '-extensions', '-reqexts'],
  x509: ['-days', '-CA', '-CAkey', '-CAserial', '-checkend', '-ext', '-set_serial', '-signkey'],
  verify: ['-CAfile', '-CApath', '-untrusted', '-purpose', '-attime', '-CRLfile'],
  ca: ['-cert', '-keyfile', '-days', '-subj', '-infiles', '-revoke'],
  s_client: ['-connect', '-servername', '-CAfile', '-verify', '-port'],
  s_server: ['-accept', '-cert', '-key', '-port'],
  crl: ['-CAfile'],
  errstr: [],
  list: [],
  prime: ['-bits', '-checks', '-generate'],
  ecparam: ['-name'],
  pkeyutl: ['-inkey', '-sigfile', '-pubin'],
  rsautl: ['-inkey', '-sigfile', '-pubin'],
  // `-topk8` est un drapeau nu : le déclarer ici lui faisait avaler le
  // `-in` qui suit, et `pkcs8 -topk8 -in k -out p8` échouait en
  // réclamant le `-in` qu'on venait de lui donner.
  pkcs8: [],
  kdf: ['-kdfopt', '-keylen'],
  mac: ['-macopt', '-digest'],
};

function takesValue(sub: string, opt: string): boolean {
  if (VALUED['*'].includes(opt)) return true;
  const own = VALUED[sub];
  return own !== undefined && own.includes(opt);
}

export function parseArgs(sub: string, argv: readonly string[]): ParsedArgs {
  const opts = new Map<string, string | true>();
  const operands: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('-') && a.length > 1) {
      if (takesValue(sub, a) && i + 1 < argv.length) {
        opts.set(a, argv[i + 1]);
        i++;
      } else {
        opts.set(a, true);
      }
      continue;
    }
    operands.push(a);
  }
  return { opts, operands };
}

/** `-subj "/C=FR/O=Lab/CN=www.lab"` → `C = FR, O = Lab, CN = www.lab`. */
export function parseSubject(subj: string): string {
  const parts = subj.split('/').filter((p) => p.trim().length > 0);
  const rendered: string[] = [];
  for (const p of parts) {
    const eq = p.indexOf('=');
    if (eq === -1) continue;
    rendered.push(`${p.slice(0, eq).trim()} = ${p.slice(eq + 1).trim()}`);
  }
  return rendered.join(', ');
}
