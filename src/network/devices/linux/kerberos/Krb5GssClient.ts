import type { TgsExchangeResult } from '@/network/kerberos/KerberosClient';
import { KDC_OPT_CANONICALIZE, KDC_OPT_RENEWABLE, KrbErrorCode, principalName, PrincipalNameType } from '@/network/kerberos/types';
import type { GssAcquisition, GssClientEnvironment } from '@/network/kerberos/gssapi/GssClientEnvironment';
import { GSS_S_FAILURE, GSS_S_NO_CRED, gssFailure } from '@/network/kerberos/gssapi/GssStatus';
import type { Ccache, CcacheCredential } from '@/network/kerberos/ccache/FileCcache';
import { Krb5Context } from './Krb5Context';
import {
  FileCredentialCache, ccachePathOf, credentialFromExchange, fromCcachePrincipal, parseCcacheName,
  ticketOfCredential,
} from './Krb5Ccache';
import { kdcErrorMessage, noKdcForRealm, unreachableKdc } from './Krb5Errors';
import type { Krb5Host } from './Krb5Host';
import { unparsePrincipal } from './Krb5Principal';

const TICKET_EXPIRED = 'Ticket expired';
const TGS_OPTIONS = KDC_OPT_RENEWABLE;
const REFERRAL_REALM = '';
const IP_LITERAL = /^(\d{1,3}\.){3}\d{1,3}$|^[0-9a-f:]*:[0-9a-f:]*$/i;

function noCredentials(minor: string): GssAcquisition {
  return { kind: 'failure', failure: gssFailure(GSS_S_NO_CRED, minor) };
}

function failure(minor: string): GssAcquisition {
  return { kind: 'failure', failure: gssFailure(GSS_S_FAILURE, minor) };
}

function isServerCredential(credential: CcacheCredential, components: readonly string[]): boolean {
  return credential.server.components.length === components.length
    && credential.server.components.every((part, index) => part === components[index])
    && credential.server.realm !== 'X-CACHECONF:';
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

  async acquire(service: string, hostName: string): Promise<GssAcquisition> {
    const cacheName = this.context.defaultCcacheName();
    const path = ccachePathOf(parseCcacheName(cacheName));
    if (path === null) return noCredentials(`No Kerberos credentials available (default cache: ${cacheName})`);
    const cache = new FileCredentialCache(this.host, path);
    if (!cache.exists()) return noCredentials(`No Kerberos credentials available (default cache: ${cacheName})`);
    const stored = cache.read();
    if (stored === null) {
      return noCredentials(`No Kerberos credentials available: Unsupported credentials cache format version number (filename: ${path})`);
    }
    if (stored.credentials.length === 0) return noCredentials('Credential cache is empty');

    const target = [service, await this.canonicalHost(hostName)];
    const client = fromCcachePrincipal(stored.defaultPrincipal);
    const now = this.nowSeconds();
    const cached = stored.credentials.find((credential) =>
      isServerCredential(credential, target) && credential.endTime > now);
    const tgt = stored.credentials.find((credential) => isTicketGrantingCredential(credential, client.realm));
    if (cached !== undefined) return this.acquisition(cached, client.realm);

    if (tgt === undefined) return failure(`Matching credential not found (filename: ${path})`);
    if (tgt.endTime <= now) return failure(TICKET_EXPIRED);
    const tgtTicket = ticketOfCredential(tgt);
    if (tgtTicket === null) return failure(`Matching credential not found (filename: ${path})`);

    const located = await this.context.locateKdcs(client.realm);
    if (located.kind === 'none') return failure(noKdcForRealm(client.realm));
    const serverName = `${target.join('/')}@${client.realm}`;
    const cname = principalName(PrincipalNameType.NT_PRINCIPAL, ...client.components);
    const askKdc = async (options: number): Promise<TgsExchangeResult | null> => {
      for (const address of located.addresses) {
        const ip = await this.host.resolve(address.host);
        if (ip === null) continue;
        const kdc = this.host.dialKdc(ip, address.port);
        if (kdc !== null) return kdc.tgsExchange(tgtTicket, tgt.key, cname, client.realm, target, client.realm, options);
      }
      return null;
    };
    let exchange = await askKdc(TGS_OPTIONS | KDC_OPT_CANONICALIZE);
    if (exchange !== null && !exchange.ok && exchange.errorCode === KrbErrorCode.KDC_ERR_S_PRINCIPAL_UNKNOWN) {
      exchange = await askKdc(TGS_OPTIONS) ?? exchange;
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
