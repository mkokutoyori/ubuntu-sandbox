import { Getopt, GETOPT_END } from '@/network/ldap/openldap/getopt';
import type { Ccache } from '@/network/kerberos/ccache/FileCcache';
import type { AsExchangeResult, AsRequestOptions } from '@/network/kerberos/KerberosClient';
import { PrincipalNameType, principalName } from '@/network/kerberos/types';
import { Krb5Context } from './Krb5Context';
import { FileCredentialCache, ccachePathOf, credentialFromExchange, fromCcachePrincipal, parseCcacheName, ticketOfCredential, toCcachePrincipal } from './Krb5Ccache';
import { kdcErrorMessage, noKdcForRealm, unreachableKdc } from './Krb5Errors';
import { parseDuration } from './Krb5Duration';
import { samePrincipal, unparsePrincipal, type Krb5Principal } from './Krb5Principal';
import { KINIT_USAGE, emit, outputOf, type ToolOutput } from './Krb5ToolOutput';
import type { Krb5Host } from './Krb5Host';

const GETOPT = 'r:fFpPnaAVl:s:c:kit:T:RS:vX:CEI:';
const WHILE_GETTING_INITIAL = 'while getting initial credentials';

interface KinitOptions {
  verbose: boolean;
  unsupported: string[];
  lifetime: number | null;
  renewable: number | null;
  forwardable: boolean | null;
  proxiable: boolean | null;
  cache: string | null;
  service: string | null;
  renew: boolean;
  principal: string | null;
}

function usageError(out: ToolOutput, message: string | null): ToolOutput {
  emit(out, 'stderr', `${message === null ? '' : `${message}\n`}${KINIT_USAGE}\n`);
  out.exitCode = 2;
  return out;
}

export async function runKinit(host: Krb5Host, args: readonly string[], stdin: string | null): Promise<ToolOutput> {
  const out = outputOf();
  const options: KinitOptions = {
    verbose: false, unsupported: [], lifetime: null, renewable: null, forwardable: null, proxiable: null, cache: null,
    service: null, renew: false, principal: null,
  };
  const argv = ['kinit', ...args.filter((argument) => argument !== '--request-pac' && argument !== '--no-request-pac')];
  let optionError = false;
  const getopt = new Getopt(argv, GETOPT, (message) => { emit(out, 'stderr', `${message}\n`); });
  for (;;) {
    const result = getopt.next();
    if (result === GETOPT_END) break;
    switch (result.option) {
      case 'V': options.verbose = true; break;
      case 'l': {
        const parsed = parseDuration(result.argument ?? '');
        if (parsed === null || parsed === 0) return usageError(out, `Bad lifetime value ${result.argument}`);
        options.lifetime = parsed;
        break;
      }
      case 'r': {
        const parsed = parseDuration(result.argument ?? '');
        if (parsed === null) return usageError(out, `Bad lifetime value ${result.argument}`);
        options.renewable = parsed;
        break;
      }
      case 's':
        if (parseDuration(result.argument ?? '') === null) return usageError(out, `Bad start time value ${result.argument}`);
        options.unsupported.push('-s');
        break;
      case 'f': options.forwardable = true; break;
      case 'F': options.forwardable = false; break;
      case 'p': options.proxiable = true; break;
      case 'P': options.proxiable = false; break;
      case 'c': options.cache = result.argument; break;
      case 'S': options.service = result.argument; break;
      case 'R': options.renew = true; break;
      case 'E': case 'a': case 'n': case 'v': case 'k': case 'C': case 'T': case 'I': case 'X': case 'i': case 't':
        options.unsupported.push(`-${result.option}`);
        break;
      case '?': optionError = true; break;
      default: break;
    }
  }
  if (optionError) return usageError(out, null);
  const operands = getopt.operands();
  if (operands.length > 1) return usageError(out, `Extra arguments (starting with "${operands[1]}").`);
  options.principal = operands[0] ?? null;
  if (options.unsupported.length > 0) {
    emit(out, 'stderr', `kinit: this simulator does not implement ${[...new Set(options.unsupported)].join(', ')}\n`);
    out.exitCode = 1;
    return out;
  }

  const context = new Krb5Context(host);
  const cacheName = options.cache ?? context.defaultCcacheName();
  const cachePath = ccachePathOf(parseCcacheName(cacheName));
  if (cachePath === null) {
    emit(out, 'stderr', `kinit: Unknown credential cache type while getting default ccache\n`);
    out.exitCode = 1;
    return out;
  }
  const cache = new FileCredentialCache(host, cachePath);
  const existing = cache.read();

  let principal: Krb5Principal;
  const principalFromCache = options.principal === null && existing !== null;
  if (options.principal !== null) {
    const parsed = context.parseName(options.principal);
    if (parsed.ok === false) {
      emit(out, 'stderr', `kinit: ${parsed.message} when parsing name ${options.principal}\n`);
      out.exitCode = 1;
      return out;
    }
    principal = parsed.principal;
  } else if (existing !== null) {
    principal = fromCcachePrincipal(existing.defaultPrincipal);
  } else {
    const user = host.userName();
    const parsed = context.parseName(user);
    if (parsed.ok === false) {
      emit(out, 'stderr', `kinit: ${parsed.message} when parsing name ${user}\n`);
      out.exitCode = 1;
      return out;
    }
    principal = parsed.principal;
  }
  const printed = unparsePrincipal(principal);
  if (options.verbose) {
    if (options.cache !== null) emit(out, 'stderr', `Using specified cache: ${options.cache}\n`);
    else if (!principalFromCache) emit(out, 'stderr', `Using default cache: ${cachePath}\n`);
    emit(out, 'stderr', `Using principal: ${printed}\n`);
  }
  if (options.renew) return renewCredential(host, context, cache, existing, principal, options, out);

  const password = (): string | null => {
    emit(out, 'stdout', `Password for ${printed}: `);
    return readPasswordLine(stdin);
  };

  const profile = context.profile();
  const renewLifetime = options.renewable ?? configuredDuration(profile.string('libdefaults', 'renew_lifetime'));
  const requestOptions: AsRequestOptions = {
    forwardable: options.forwardable ?? profile.boolean(false, 'libdefaults', 'forwardable'),
    proxiable: options.proxiable ?? profile.boolean(false, 'libdefaults', 'proxiable'),
    renewable: renewLifetime !== null && renewLifetime > 0,
    renewableOk: true,
    lifetimeSeconds: options.lifetime ?? configuredDuration(profile.string('libdefaults', 'ticket_lifetime')) ?? undefined,
    renewableLifetimeSeconds: renewLifetime ?? undefined,
  };

  const located = await context.locateKdcs(principal.realm);
  if (located.kind === 'none') {
    emit(out, 'stderr', `kinit: ${noKdcForRealm(principal.realm)} ${WHILE_GETTING_INITIAL}\n`);
    out.exitCode = 1;
    return out;
  }
  let exchange: AsExchangeResult | null = null;
  for (const address of located.addresses) {
    const ip = await host.resolve(address.host);
    if (ip === null) continue;
    const client = host.dialKdc(ip, address.port);
    if (client === null) continue;
    exchange = client.asExchange(principal.components.join('/'), password, principal.realm, serviceNameOf(options.service), requestOptions);
    break;
  }
  if (exchange === null) {
    emit(out, 'stderr', `kinit: ${unreachableKdc(principal.realm)} ${WHILE_GETTING_INITIAL}\n`);
    out.exitCode = 1;
    return out;
  }
  if (!exchange.ok) {
    const message = exchange.passwordUnavailable === true
      ? 'Cannot read password'
      : exchange.errorCode === undefined
        ? 'Cannot contact any KDC'
        : kdcErrorMessage(exchange.errorCode, printed, options.service ?? `krbtgt/${principal.realm}@${principal.realm}`);
    emit(out, 'stderr', `kinit: ${message} ${WHILE_GETTING_INITIAL}\n`);
    out.exitCode = 1;
    return out;
  }
  const credential = credentialFromExchange(principal, exchange);
  if (credential === null) {
    emit(out, 'stderr', `kinit: Cannot contact any KDC for realm '${principal.realm}' ${WHILE_GETTING_INITIAL}\n`);
    out.exitCode = 1;
    return out;
  }
  const stored: Ccache = {
    kdcOffsetSeconds: 0, kdcOffsetMicroseconds: 0, defaultPrincipal: toCcachePrincipal(principal), credentials: [credential],
  };
  if (!cache.write(stored)) {
    emit(out, 'stderr', `kinit: Permission denied while initializing ccache\n`);
    out.exitCode = 1;
    return out;
  }
  if (options.verbose) emit(out, 'stderr', 'Authenticated to Kerberos v5\n');
  return out;
}

const WHILE_RENEWING = 'while renewing credentials';

async function renewCredential(
  host: Krb5Host, context: Krb5Context, cache: FileCredentialCache, existing: Ccache | null,
  principal: Krb5Principal, options: KinitOptions, out: ToolOutput,
): Promise<ToolOutput> {
  const fail = (message: string): ToolOutput => {
    emit(out, 'stderr', `kinit: ${message} ${WHILE_RENEWING}\n`);
    out.exitCode = 1;
    return out;
  };
  if (existing === null) return fail(`No credentials cache found (filename: ${cache.path})`);
  const wanted = options.service === null
    ? { components: ['krbtgt', principal.realm], realm: principal.realm }
    : serviceOf(options.service, principal.realm);
  const printed = unparsePrincipal(principal);
  const credential = existing.credentials.find((candidate) =>
    samePrincipal(fromCcachePrincipal(candidate.client), principal)
    && candidate.server.realm === wanted.realm
    && candidate.server.components.join('/') === wanted.components.join('/'));
  const ticket = credential === undefined ? null : ticketOfCredential(credential);
  if (credential === undefined || ticket === null) return fail(`Matching credential not found (filename: ${cache.path})`);

  const located = await context.locateKdcs(principal.realm);
  if (located.kind === 'none') return fail(noKdcForRealm(principal.realm));
  let exchange: AsExchangeResult | null = null;
  for (const address of located.addresses) {
    const ip = await host.resolve(address.host);
    if (ip === null) continue;
    const client = host.dialKdc(ip, address.port);
    if (client === null) continue;
    exchange = client.renewExchange(
      ticket, credential.key, principalName(PrincipalNameType.NT_PRINCIPAL, ...principal.components),
      principal.realm, credential.renewTill,
    );
    break;
  }
  if (exchange === null) return fail(unreachableKdc(principal.realm));
  if (!exchange.ok) {
    return fail(exchange.errorCode === undefined ? 'Cannot contact any KDC' : kdcErrorMessage(exchange.errorCode, printed, options.service ?? `krbtgt/${principal.realm}@${principal.realm}`));
  }
  const renewed = credentialFromExchange(principal, exchange);
  if (renewed === null) return fail(unreachableKdc(principal.realm));
  const stored: Ccache = {
    kdcOffsetSeconds: 0, kdcOffsetMicroseconds: 0, defaultPrincipal: toCcachePrincipal(principal), credentials: [renewed],
  };
  if (!cache.write(stored)) return fail('Permission denied');
  if (options.verbose) emit(out, 'stderr', 'Initialized cache\nStored credentials\nAuthenticated to Kerberos v5\n');
  return out;
}

function serviceOf(service: string, defaultRealm: string): { components: string[]; realm: string } {
  const at = service.lastIndexOf('@');
  const body = at < 0 ? service : service.slice(0, at);
  return { components: body.split('/'), realm: at < 0 ? defaultRealm : service.slice(at + 1) };
}

function readPasswordLine(stdin: string | null): string | null {
  if (stdin === null || stdin === '') return null;
  const newline = stdin.indexOf('\n');
  return newline < 0 ? stdin : stdin.slice(0, newline);
}

function configuredDuration(text: string | null): number | null {
  return text === null ? null : parseDuration(text);
}

function serviceNameOf(service: string | null): string | readonly string[] | undefined {
  if (service === null) return undefined;
  const slash = service.indexOf('@');
  const body = slash < 0 ? service : service.slice(0, slash);
  return body.split('/');
}
