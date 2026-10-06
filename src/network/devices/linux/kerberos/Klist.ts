import { Getopt, GETOPT_END } from '@/network/ldap/openldap/getopt';
import type { Ccache, CcacheCredential } from '@/network/kerberos/ccache/FileCcache';
import { AES256_CTS_HMAC_SHA1_96 } from '@/network/kerberos/crypto';
import { Krb5Context } from './Krb5Context';
import { FileCredentialCache, ccachePathOf, fromCcachePrincipal, isConfigurationCredential, parseCcacheName } from './Krb5Ccache';
import { formatKlistTime } from './Krb5Duration';
import { unparsePrincipal } from './Krb5Principal';
import { KLIST_USAGE, emit, outputOf, type ToolOutput } from './Krb5ToolOutput';
import type { Krb5Host } from './Krb5Host';

export const KRB5_VERSION_STRING = 'Kerberos 5 version 1.19.2';

const ENCRYPTION_TYPE_NAMES: Readonly<Record<number, string>> = {
  [AES256_CTS_HMAC_SHA1_96]: 'aes256-cts-hmac-sha1-96',
  17: 'aes128-cts-hmac-sha1-96',
  23: 'arcfour-hmac',
};

const FLAG_LETTERS: readonly (readonly [number, string])[] = [
  [1, 'F'], [2, 'f'], [3, 'P'], [4, 'p'], [5, 'D'], [6, 'd'], [7, 'i'], [8, 'R'], [9, 'I'], [10, 'A'], [11, 'H'],
  [12, 'T'], [13, 'O'], [14, 'a'],
];

function flagString(flags: number): string {
  return FLAG_LETTERS.filter(([bit]) => (flags & (1 << (31 - bit))) !== 0).map(([, letter]) => letter).join('');
}

function etypeName(type: number): string {
  return ENCRYPTION_TYPE_NAMES[type] ?? `etype ${type}`;
}

function noCache(path: string): ToolOutput {
  const out = outputOf();
  emit(out, 'stderr', `klist: No credentials cache found (filename: ${path})\n`);
  out.exitCode = 1;
  return out;
}

function usage(out: ToolOutput, message: string | null): ToolOutput {
  emit(out, 'stderr', `${message === null ? '' : `${message}\n`}${KLIST_USAGE}\n`);
  out.exitCode = 1;
  return out;
}

function credentialLines(
  credential: CcacheCredential, showFlags: boolean, showEtype: boolean, showAddresses: boolean, showAuthData: boolean,
): string {
  let text = `${formatKlistTime(credential.startTime)}  ${formatKlistTime(credential.endTime)}  `;
  text += `${unparsePrincipal(fromCcachePrincipal(credential.server))}\n`;
  const renewable = (credential.flags & (1 << (31 - 8))) !== 0 && credential.renewTill !== 0;
  let extra = 0;
  if (renewable) {
    text += `\trenew until ${formatKlistTime(credential.renewTill)}`;
    extra++;
  }
  if (showFlags) {
    text += `${extra > 0 ? ', ' : '\t'}Flags: ${flagString(credential.flags)}`;
    extra++;
  }
  if (showEtype) {
    const body = `Etype (skey, tkt): ${etypeName(credential.keyType)}, ${etypeName(credential.keyType)} `;
    text += extra > 1 ? `\n\t${body}` : `${extra > 0 ? ', ' : '\t'}${body}`;
    extra++;
  }
  if (showAuthData) {
    const types = credential.authData.map((item) => String(item.type)).join(', ');
    text += `${extra > 1 ? '\n\t' : extra > 0 ? ', ' : '\t'}AD types: ${types}`;
    extra++;
  }
  if (extra > 0) text += '\n';
  if (showAddresses) {
    text += credential.addresses.length === 0
      ? '\tAddresses: (none)\n'
      : `\tAddresses: ${credential.addresses.map((address) => Array.from(address.data).join('.')).join(', ')}\n`;
  }
  return text;
}

function isValidTgt(credential: CcacheCredential, nowSeconds: number): boolean {
  const server = credential.server;
  return server.components.length === 2 && server.components[0] === 'krbtgt' && server.components[1] === server.realm
    && credential.endTime > nowSeconds;
}

function listCache(cache: Ccache, name: string, options: { flags: boolean; etype: boolean; addresses: boolean; authData: boolean; config: boolean }): string {
  let text = `Ticket cache: ${name}\nDefault principal: ${unparsePrincipal(fromCcachePrincipal(cache.defaultPrincipal))}\n\nValid starting     Expires            Service principal\n`;
  for (const credential of cache.credentials) {
    if (isConfigurationCredential(credential)) continue;
    text += credentialLines(credential, options.flags, options.etype, options.addresses, options.authData);
  }
  return text;
}

export async function runKlist(host: Krb5Host, args: readonly string[]): Promise<ToolOutput> {
  const out = outputOf();
  const flags = {
    etype: false, version: false, list: false, all: false, authData: false, showFlags: false, silent: false,
    addresses: false, noReverse: false, keytab: false, config: false, timestamps: false, keys: false, defaultKeytab: false,
  };
  let optionError = false;
  const getopt = new Getopt(['klist', ...args], 'ekKsatdfcCinVlA', (message) => { emit(out, 'stderr', `${message}\n`); });
  for (;;) {
    const result = getopt.next();
    if (result === GETOPT_END) break;
    switch (result.option) {
      case 'e': flags.etype = true; break;
      case 'V': flags.version = true; break;
      case 'l': flags.list = true; break;
      case 'A': flags.all = true; break;
      case 'd': flags.authData = true; break;
      case 'f': flags.showFlags = true; break;
      case 's': flags.silent = true; break;
      case 'a': flags.addresses = true; break;
      case 'n': flags.noReverse = true; break;
      case 'k': flags.keytab = true; break;
      case 'C': flags.config = true; break;
      case 't': flags.timestamps = true; break;
      case 'K': flags.keys = true; break;
      case 'i': flags.defaultKeytab = true; break;
      case 'c': break;
      case '?': optionError = true; break;
      default: break;
    }
  }
  if (optionError) return usage(out, null);
  const operands = getopt.operands();
  if (flags.version) {
    emit(out, 'stdout', `${KRB5_VERSION_STRING}\n`);
    return out;
  }
  if (operands.length > 1) return usage(out, `Extra arguments (starting with "${operands[1]}").`);
  if (flags.keytab) {
    emit(out, 'stderr', 'klist: Keytab files are not supported by this simulator\n');
    out.exitCode = 1;
    return out;
  }
  const context = new Krb5Context(host);
  const name = operands[0] ?? context.defaultCcacheName();
  const parsedName = parseCcacheName(name);
  const path = ccachePathOf(parsedName);
  if (path === null) return noCache(name);
  const store = new FileCredentialCache(host, path);
  const cache = store.exists() ? store.read() : null;

  if (flags.list) {
    emit(out, 'stdout', 'Principal name                 Cache name\n--------------                 ----------\n');
    if (cache === null) {
      out.exitCode = 1;
      return out;
    }
    emit(out, 'stdout', `${unparsePrincipal(fromCcachePrincipal(cache.defaultPrincipal)).padEnd(30)} ${parsedName.type}:${path}\n`);
    return out;
  }
  if (flags.all && cache === null) {
    out.exitCode = 1;
    return out;
  }
  if (cache === null) return noCache(path);
  if (flags.silent) {
    out.exitCode = cache.credentials.some((credential) => isValidTgt(credential, host.nowSeconds())) ? 0 : 1;
    return out;
  }
  emit(out, 'stdout', listCache(cache, `${parsedName.type}:${path}`, {
    flags: flags.showFlags, etype: flags.etype, addresses: flags.addresses, authData: flags.authData, config: flags.config,
  }));
  return out;
}
