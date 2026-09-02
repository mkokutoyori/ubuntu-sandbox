/**
 * Cisco secret/password rendering for `show running-config`.
 *
 * Real IOS never echoes a cleartext password back in the config: an
 * `enable secret` is stored as an md5crypt ($1$) hash, and with `service
 * password-encryption` even the reversible line/enable passwords are shown
 * type-7 encoded. These pure helpers reproduce that, backed by the genuine
 * algorithms in `@/crypto`, so the simulator stops leaking plaintext.
 */

import { md5Crypt, ciscoType8, ciscoType9, encryptType7, md5Hex } from '@/crypto';

export type SecretAlgo =
  | 'plain' | 'plain-password' | 'md5' | 'sha256' | 'scrypt' | 'type-7'
  | 'sha512' | 'cipher' | 'irreversible-cipher';

/** Map a modular-crypt prefix to the Cisco "type" number IOS prints for it. */
function cryptPrefixType(value: string): number | null {
  if (value.startsWith('$1$')) return 5; // md5crypt
  if (value.startsWith('$8$')) return 8; // pbkdf2-sha256
  if (value.startsWith('$9$')) return 9; // scrypt
  return null;
}

/**
 * Render the `<type-number> <value>` suffix of an `enable secret` /
 * `username … secret` line. Plaintext is hashed with the real algorithm for
 * its type (md5crypt for type-5, PBKDF2 for type-8); values already in
 * modular-crypt form pass through under their own type number.
 */
export function renderSecretField(value: string, algo: SecretAlgo, scope = ''): string {
  const preHashed = cryptPrefixType(value);
  if (preHashed !== null) return `${preHashed} ${value}`;
  switch (algo) {
    // Le chiffre `0` d'un `secret` decrit la SAISIE, pas le stockage : un
    // `secret` est irreversible par definition, et IOS rend
    // `enable secret 0 cisco` en `enable secret 5 $1$…`. Le ranger comme
    // un algorithme faisait ressortir le mot de passe en clair dans la
    // configuration — pour les trois commandes de la famille, et dans le
    // meme fichier ou la forme nue etait hachee. La famille REVERSIBLE
    // (`password`) a son propre rendu, ou le clair est legitime tant que
    // `service password-encryption` n'est pas pose.
    case 'plain':
    case 'md5':
      return `5 ${md5Crypt(value, deriveCryptSalt(value, scope))}`;
    case 'sha256':
      return `8 ${ciscoType8(value, deriveType8Salt(value, scope))}`; // PBKDF2-HMAC-SHA256
    case 'scrypt':
      return `9 ${ciscoType9(value, deriveType9Salt(value, scope))}`;
    case 'type-7':
      return `7 ${value}`;
    default:
      return `0 ${value}`;
  }
}

/**
 * Render the `<type-number> <value>` suffix of an `enable password` / line
 * `password` / `username … password`. Plaintext is type-7 encoded when
 * `service password-encryption` is enabled; an already type-7 value is
 * emitted verbatim.
 *
 * `showZeroType` controls whether the unencrypted case is prefixed with an
 * explicit `0 ` — real IOS shows it for `username … password 0 …` but
 * omits it for `enable password` (default `true`; `enable password`
 * call sites pass `false`).
 */
export function renderPasswordField(
  value: string,
  algo: 'plain' | 'plain-password' | 'type-7',
  serviceEncryption: boolean,
  showZeroType: boolean = true,
  scope = '',
): string {
  if (algo === 'type-7') return `7 ${value}`;
  if (serviceEncryption) return `7 ${encryptType7(value, deriveType7Salt(value, scope))}`;
  return showZeroType ? `0 ${value}` : value;
}

/**
 * Deterministic 8-char salt drawn from the crypt alphabet (hex is a subset).
 * Real IOS randomises it; the simulator favours stable, reproducible output.
 *
 * `scope` is the entry's own identity (`enable`, `enable:7`,
 * `username:admin`). Without it the salt derived from the SECRET alone, so
 * two entries sharing a password shared their salt — which no real crypt
 * can produce, and which `enable secret` and `username admin` demonstrated
 * on every configuration where both used the same word.
 */
function deriveCryptSalt(seed: string, scope: string): string {
  return md5Hex(`cisco-secret:${scope}:${seed}`).slice(0, 8);
}

/** Deterministic 14-char type-8 salt (hex is a subset of the crypt alphabet). */
function deriveType8Salt(seed: string, scope: string): string {
  return md5Hex(`cisco-type8:${scope}:${seed}`).slice(0, 14);
}

/** Deterministic 14-char type-9 (scrypt) salt. */
function deriveType9Salt(seed: string, scope: string): string {
  return md5Hex(`cisco-type9:${scope}:${seed}`).slice(0, 14);
}

/** Deterministic type-7 key offset in [0, 15] derived from the secret. */
function deriveType7Salt(seed: string, scope: string): number {
  return Number.parseInt(md5Hex(`cisco-type7:${scope}:${seed}`).slice(0, 1), 16);
}

export interface CiscoRenderableAccount {
  name: string;
  privilege: number;
  secret: string;
  secretAlgo?: SecretAlgo;
  noPassword?: boolean;
  description?: string | null;
  view?: string | null;
  autocommand?: string | null;
  noHangup?: boolean;
  oneTime?: boolean;
  accessClassIn?: number | null;
  maxConcurrentSessions?: number;
}

function usernameOptionSuffix(a: CiscoRenderableAccount): string {
  const parts: string[] = [];
  if (a.accessClassIn !== null && a.accessClassIn !== undefined) {
    parts.push(`access-class ${a.accessClassIn}`);
  }
  if ((a.maxConcurrentSessions ?? 0) > 0) {
    parts.push(`user-maxlinks ${a.maxConcurrentSessions}`);
  }
  if (a.oneTime) parts.push('one-time');
  if (a.noHangup) parts.push('nohangup');
  return parts.length > 0 ? ` ${parts.join(' ')}` : '';
}

export const USERNAME_DEFAULT_PRIVILEGE = 1;

export function renderCiscoUsernameLines(
  a: CiscoRenderableAccount, serviceEncryption: boolean,
): string[] {
  const algo = a.secretAlgo ?? 'md5';
  const credential = a.noPassword
    ? 'nopassword'
    : (algo === 'type-7' || algo === 'plain-password')
      ? `password ${renderPasswordField(a.secret, algo, serviceEncryption, true, `username:${a.name}`)}`
      : a.secret === ''
        ? ''
        : `secret ${renderSecretField(a.secret, algo, `username:${a.name}`)}`;

  const head = a.privilege === USERNAME_DEFAULT_PRIVILEGE
    ? `username ${a.name}`
    : `username ${a.name} privilege ${a.privilege}`;
  const suffix = usernameOptionSuffix(a);
  const lines = [credential === '' ? `${head}${suffix}` : `${head}${suffix} ${credential}`];
  if (a.description) lines.push(`username ${a.name} description ${a.description}`);
  if (a.autocommand) lines.push(`username ${a.name} autocommand ${a.autocommand}`);
  if (a.view) lines.push(`username ${a.name} view ${a.view}`);
  return lines;
}
