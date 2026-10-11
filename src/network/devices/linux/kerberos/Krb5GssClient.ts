import type { KerberosClient, TgsExchangeResult } from '@/network/kerberos/KerberosClient';
import {
  KDC_OPT_CANONICALIZE, KDC_OPT_FORWARDABLE, KDC_OPT_FORWARDED, KDC_OPT_PROXIABLE, KDC_OPT_RENEWABLE, PA_AS_FRESHNESS, PA_REQ_ENC_PA_REP, KrbErrorCode, principalName, PrincipalNameType,
} from '@/network/kerberos/types';
import type { GssAcquisition, GssClientEnvironment, GssCredentialAcquisition } from '@/network/kerberos/gssapi/GssClientEnvironment';
import type { ForwardedCredential } from '@/network/kerberos/gssapi/GssInitiator';
import { ticketFlagsFromBits, ticketFlagsToBits } from '@/network/kerberos/codec';
import { GSS_S_CREDENTIALS_EXPIRED, GSS_S_FAILURE, GSS_S_NO_CRED, gssFailure, type GssFailure } from '@/network/kerberos/gssapi/GssStatus';
import type { Ccache, CcacheCredential } from '@/network/kerberos/ccache/FileCcache';
import { Krb5Context, type KdcAddress } from './Krb5Context';
import {
  FileCredentialCache, ccachePathOf, credentialFromExchange, fromCcachePrincipal, parseCcacheName,
  ticketOfCredential, toCcachePrincipal,
} from './Krb5Ccache';
import { kdcErrorMessage, noKdcForRealm, unreachableKdc } from './Krb5Errors';
import type { Krb5Host } from './Krb5Host';
import { samePrincipal, unparsePrincipal, type Krb5Principal } from './Krb5Principal';

const TICKET_EXPIRED = 'Ticket expired';
const REFRESH_WINDOW_SECONDS = 30;
const REFRESH_TIME_KEY = 'refresh_time';
const CONFIGURATION_REALM = 'X-CACHECONF:';
const CONFIGURATION_DATA = 'krb5_ccache_conf_data';
const CCACHE_NO_MATCH = 'Principal in credential cache does not match desired name';
const NO_MINOR_CODE = 'Success';
const FORWARD_ATTEMPTS = 2;
const PERMITTED_ENCTYPES = [18, 17, 20, 19, 16, 23, 25, 26];
const REFERRAL_REALM = '';
const IP_LITERAL = /^(\d{1,3}\.){3}\d{1,3}$|^[0-9a-f:]*:[0-9a-f:]*$/i;

function failure(minor: string): GssAcquisition {
  return { kind: 'failure', failure: gssFailure(GSS_S_FAILURE, minor) };
}

function isServerCredential(credential: CcacheCredential, components: readonly string[]): boolean {
  return credential.server.components.length === components.length
    && credential.server.components.every((part, index) => part === components[index])
    && credential.server.realm !== CONFIGURATION_REALM;
}

function inheritedOptions(tgt: CcacheCredential): number {
  const held = ticketFlagsFromBits(tgt.flags);
  return (held.forwardable ? KDC_OPT_FORWARDABLE : 0) | (held.proxiable ? KDC_OPT_PROXIABLE : 0) | (held.renewable ? KDC_OPT_RENEWABLE : 0);
}

function isRefreshNote(credential: CcacheCredential): boolean {
  return credential.server.realm === CONFIGURATION_REALM
    && credential.server.components.length === 2
    && credential.server.components[1] === REFRESH_TIME_KEY;
}

function isTicketGrantingCredential(credential: CcacheCredential, realm: string): boolean {
  return credential.server.realm === realm
    && credential.server.components.length === 2
    && credential.server.components[0] === 'krbtgt'
    && credential.server.components[1] === realm;
}

export class Krb5GssClient implements GssClientEnvironment {
  readonly clock = { nowMicroseconds: () => this.host.nowMicroseconds() };

  constructor(private readonly host: Krb5Host, private readonly context: Krb5Context) {}

  private nowSeconds(): number {
    return Math.floor(this.host.nowMicroseconds() / 1_000_000);
  }

  private async canonicalHost(name: string): Promise<string> {
    const profile = this.context.profile();
    const mode = profile.string('libdefaults', 'dns_canonicalize_hostname');
    const lowered = name.toLowerCase();
    if (IP_LITERAL.test(lowered) || (mode !== null && mode.toLowerCase() !== 'true')) return lowered;
    const forward = await this.host.forward(lowered);
    if (forward === null) return lowered;
    if (profile.boolean(true, 'libdefaults', 'rdns')) {
      const reverse = await this.host.reverse(forward.address);
      if (reverse !== null && reverse !== '') return reverse.toLowerCase();
    }
    return forward.canonicalName.toLowerCase();
  }

  private openDefaultCache(): { kind: 'open'; cache: FileCredentialCache; stored: Ccache; path: string } | { kind: 'failure'; failure: GssFailure } {
    const cacheName = this.context.defaultCcacheName();
    const missing = gssFailure(GSS_S_NO_CRED, `No Kerberos credentials available (default cache: ${cacheName})`);
    const path = ccachePathOf(parseCcacheName(cacheName));
    if (path === null) return { kind: 'failure', failure: missing };
    const cache = new FileCredentialCache(this.host, path);
    if (!cache.exists()) return { kind: 'failure', failure: missing };
    const stored = cache.read();
    if (stored === null) {
      return {
        kind: 'failure',
        failure: gssFailure(GSS_S_NO_CRED, `No Kerberos credentials available: Unsupported credentials cache format version number (filename: ${path})`),
      };
    }
    if (stored.credentials.length === 0) return { kind: 'failure', failure: gssFailure(GSS_S_NO_CRED, 'Credential cache is empty') };
    return { kind: 'open', cache, stored, path };
  }

  private async refreshIfDue(cache: FileCredentialCache, stored: Ccache, client: Krb5Principal): Promise<Ccache> {
    const now = this.nowSeconds();
    const tgt = stored.credentials.find((credential) => isTicketGrantingCredential(credential, client.realm));
    if (tgt !== undefined && now + REFRESH_WINDOW_SECONDS > tgt.endTime) {
      return this.attemptClientKeytabRefresh(cache, stored, client, now);
    }
    return stored;
  }

  async acquireCredentials(name: string | null): Promise<GssCredentialAcquisition> {
    const opened = this.openDefaultCache();
    if (opened.kind === 'failure') return opened;
    const client = fromCcachePrincipal(opened.stored.defaultPrincipal);
    if (name !== null) {
      const wanted = this.context.parseName(name);
      if (!wanted.ok || !samePrincipal(wanted.principal, client)) {
        return { kind: 'failure', failure: gssFailure(GSS_S_NO_CRED, CCACHE_NO_MATCH) };
      }
    }
    const stored = await this.refreshIfDue(opened.cache, opened.stored, client);
    const tgt = stored.credentials.find((credential) => isTicketGrantingCredential(credential, client.realm));
    const lifetimeEnd = tgt !== undefined ? tgt.endTime : stored.credentials.find((credential) => !isRefreshNote(credential))?.endTime ?? 0;
    if (lifetimeEnd <= this.nowSeconds()) return { kind: 'failure', failure: gssFailure(GSS_S_CREDENTIALS_EXPIRED, NO_MINOR_CODE) };
    return { kind: 'credentials', name: unparsePrincipal(client) };
  }

  async acquire(service: string, hostName: string, delegate = false): Promise<GssAcquisition> {
    const acquired = await this.acquireServiceTicket(service, hostName);
    if (!delegate || acquired.kind !== 'credential') return acquired;
    const forwarded = await this.forwardTicketGrantingTicket();
    return forwarded === null ? acquired : { kind: 'credential', credential: { ...acquired.credential, forwarded } };
  }

  private async forwardTicketGrantingTicket(): Promise<ForwardedCredential | null> {
    const opened = this.openDefaultCache();
    if (opened.kind === 'failure') return null;
    const client = fromCcachePrincipal(opened.stored.defaultPrincipal);
    const tgt = opened.stored.credentials.find((credential) => isTicketGrantingCredential(credential, client.realm));
    const tgtTicket = tgt === undefined ? null : ticketOfCredential(tgt);
    if (tgt === undefined || tgtTicket === null) return null;
    const located = await this.context.locateKdcs(client.realm);
    if (located.kind === 'none') return null;
    const held = ticketFlagsFromBits(tgt.flags);
    const options = KDC_OPT_FORWARDED | inheritedOptions(tgt);
    const cname = principalName(PrincipalNameType.NT_PRINCIPAL, ...client.components);
    const shape = { nameType: PrincipalNameType.NT_SRV_INST, till: tgt.endTime, renewTill: held.renewable ? tgt.renewTill : undefined };
    let exchange: TgsExchangeResult | null = null;
    for (let attempt = 0; attempt < FORWARD_ATTEMPTS && (exchange === null || !exchange.ok); attempt++) {
      exchange = await this.withKdc(located.addresses, (kdc) =>
        kdc.tgsExchange(tgtTicket, tgt.key, cname, client.realm, ['krbtgt', client.realm], client.realm, options, shape));
    }
    const part = exchange?.encKdcRepPart;
    if (exchange === null || !exchange.ok || exchange.ticket === undefined || part === undefined) return null;
    return {
      ticket: exchange.ticket,
      info: {
        key: part.key, prealm: client.realm, pname: cname, flags: ticketFlagsToBits(part.flags), authtime: part.authtime, starttime: part.starttime,
        endtime: part.endtime, renewTill: part.renewTill, srealm: part.srealm, sname: part.sname,
      },
    };
  }

  private async acquireServiceTicket(service: string, hostName: string): Promise<GssAcquisition> {
    const opened = this.openDefaultCache();
    if (opened.kind === 'failure') return opened;
    const { cache, path } = opened;
    const client = fromCcachePrincipal(opened.stored.defaultPrincipal);
    const target = [service, await this.canonicalHost(hostName)];
    const now = this.nowSeconds();
    const stored = await this.refreshIfDue(cache, opened.stored, client);
    const tgt = stored.credentials.find((credential) => isTicketGrantingCredential(credential, client.realm));
    const cached = stored.credentials.find((credential) =>
      isServerCredential(credential, target) && credential.endTime > now);
    if (cached !== undefined) return this.acquisition(cached, client.realm);

    if (tgt === undefined) return failure(`Matching credential not found (filename: ${path})`);
    if (tgt.endTime <= now) return failure(TICKET_EXPIRED);
    const tgtTicket = ticketOfCredential(tgt);
    if (tgtTicket === null) return failure(`Matching credential not found (filename: ${path})`);

    const located = await this.context.locateKdcs(client.realm);
    if (located.kind === 'none') return failure(noKdcForRealm(client.realm));
    const serverName = `${target.join('/')}@${client.realm}`;
    const cname = principalName(PrincipalNameType.NT_PRINCIPAL, ...client.components);
    const askKdc = (options: number): Promise<TgsExchangeResult | null> => this.withKdc(located.addresses, (kdc) =>
      kdc.tgsExchange(tgtTicket, tgt.key, cname, client.realm, target, client.realm, options));
    let exchange = await askKdc(inheritedOptions(tgt) | KDC_OPT_CANONICALIZE);
    if (exchange !== null && !exchange.ok && exchange.errorCode === KrbErrorCode.KDC_ERR_S_PRINCIPAL_UNKNOWN) {
      exchange = await askKdc(inheritedOptions(tgt)) ?? exchange;
    }
    if (exchange === null) return failure(unreachableKdc(client.realm));
    if (!exchange.ok) {
      return failure(exchange.errorCode === undefined
        ? unreachableKdc(client.realm)
        : kdcErrorMessage(exchange.errorCode, unparsePrincipal(client), serverName));
    }
    const issued = credentialFromExchange(client, exchange);
    if (issued === null) return failure(unreachableKdc(client.realm));
    const credential: CcacheCredential = {
      ...issued,
      server: { nameType: PrincipalNameType.NT_SRV_HST, realm: REFERRAL_REALM, components: target },
    };
    const extended: Ccache = { ...stored, credentials: [...stored.credentials, credential] };
    cache.write(extended);
    return this.acquisition(credential, client.realm);
  }

  private async withKdc<T>(addresses: readonly KdcAddress[], exchange: (kdc: KerberosClient) => T): Promise<T | null> {
    for (const address of addresses) {
      const ip = await this.host.resolve(address.host);
      if (ip === null) continue;
      const kdc = this.host.dialKdc(ip, address.port);
      if (kdc !== null) return exchange(kdc);
    }
    return null;
  }

  private async attemptClientKeytabRefresh(cache: FileCredentialCache, stored: Ccache, client: Krb5Principal, now: number): Promise<Ccache> {
    const note: CcacheCredential = {
      client: toCcachePrincipal(client),
      server: {
        nameType: PrincipalNameType.NT_PRINCIPAL, realm: CONFIGURATION_REALM, components: [CONFIGURATION_DATA, REFRESH_TIME_KEY],
      },
      keyType: 0, key: new Uint8Array(0), authTime: 0, startTime: 0, endTime: 0, renewTill: 0, isSessionKey: false, flags: 0,
      addresses: [], authData: [], ticket: new TextEncoder().encode(String(now + REFRESH_WINDOW_SECONDS)), secondTicket: new Uint8Array(0),
    };
    const kept = stored.credentials.filter((credential) => !isRefreshNote(credential));
    const noted: Ccache = { ...stored, credentials: [...kept, note] };
    cache.write(noted);
    const located = await this.context.locateKdcs(client.realm);
    if (located.kind === 'found') {
      await this.withKdc(located.addresses, (kdc) => kdc.requestInitialCredentialsWithoutKey(client.components.join('/'), client.realm, {
        forwardable: false, renewable: false, renewableOk: true, etypes: PERMITTED_ENCTYPES,
        padata: [{ type: PA_AS_FRESHNESS, value: new Uint8Array(0) }, { type: PA_REQ_ENC_PA_REP, value: new Uint8Array(0) }],
      }));
    }
    return noted;
  }

  private acquisition(credential: CcacheCredential, clientRealm: string): GssAcquisition {
    const ticket = ticketOfCredential(credential);
    if (ticket === null) return failure('Malformed ticket in the credentials cache');
    const client = credential.client;
    return {
      kind: 'credential',
      credential: {
        ticket,
        sessionKey: credential.key,
        clientName: principalName(client.nameType, ...client.components),
        clientRealm: client.realm || clientRealm,
      },
    };
  }
}
