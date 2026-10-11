import { CertificateVerifier } from '@/network/pki/CertificateVerifier';
import type { X509Certificate } from '@/network/pki/X509Certificate';
import { gnutlsClientConfig } from '@/network/tls/gnutls/gnutlsClientConfig';
import type { TlsClientConfig } from '@/network/tls/TlsClientSession';
import type { TlsUpgradeOutcome, TlsUpgradeRequest } from '../ldapChannel';
import { LdapDebug } from '../ldapLog';
import {
  GNUTLS_E_FATAL_ALERT_RECEIVED, GNUTLS_E_NO_PRIORITIES_WERE_SET, GNUTLS_E_PREMATURE_TERMINATION, gnutlsStrerror,
} from './gnutlsErrors';
import { initTlsContext, type TlsFiles } from './tlsContext';
import { judgeChain, judgePeer, type ChainVerification, type PeerVerdict } from './tlsPeerPolicy';

export interface TlsHandshakeFacts {
  readonly established: boolean;
  readonly alert: boolean;
  readonly certificate: X509Certificate | null;
  readonly verification: ChainVerification;
}

export interface TlsConnectHost {
  readonly files: TlsFiles;
  localFqdn(): Promise<string>;
  handshake(config: TlsClientConfig): TlsHandshakeFacts;
  detach(): void;
}

const NUMERIC_HOST = /^[0-9.]*(:.*)?$/;
const UNKNOWN_ERROR = -1;

function indicationOf(host: string): string | undefined {
  return NUMERIC_HOST.test(host) ? undefined : host;
}

function reportFailure(request: TlsUpgradeRequest, verdict: Extract<PeerVerdict, { ok: false }>): TlsUpgradeOutcome {
  for (const line of verdict.lines) request.debug(line.level, line.text);
  const detail = gnutlsStrerror(UNKNOWN_ERROR);
  request.debug(LdapDebug.ANY, `TLS: can't connect: ${detail}.\n`);
  return { ok: false, detail, errno: verdict.errno };
}

function handshakeFailure(request: TlsUpgradeRequest, code: number): TlsUpgradeOutcome {
  const detail = gnutlsStrerror(code);
  request.debug(LdapDebug.ANY, `TLS: can't connect: ${detail}.\n`);
  return { ok: false, detail, errno: null };
}

export async function connectTls(request: TlsUpgradeRequest, host: TlsConnectHost): Promise<TlsUpgradeOutcome> {
  const hostName = request.serverName === '' ? 'localhost' : request.serverName;
  const initialised = initTlsContext(request.tls, host.files, request.debug);
  if (initialised.ok === false) {
    request.debug(LdapDebug.ANY, `TLS: init_def_ctx: ${initialised.errmsg}.\n`);
    return { ok: false, detail: null, errno: null };
  }
  const { context } = initialised;
  const offer = gnutlsClientConfig(context.priority);
  if (offer.versions.length === 0) return handshakeFailure(request, GNUTLS_E_NO_PRIORITIES_WERE_SET);
  const config: TlsClientConfig = {
    ...offer,
    verifier: new CertificateVerifier({
      trustAnchors: context.trustAnchors,
      crls: context.revocationLists,
      revocationCheck: context.revocationLists.length > 0 ? 'crl' : 'none',
    }),
    allowUntrustedPeer: true,
    verifyHostname: false,
    serverName: indicationOf(hostName),
  };
  const facts = host.handshake(config);
  if (!facts.established) {
    return handshakeFailure(request, facts.alert ? GNUTLS_E_FATAL_ALERT_RECEIVED : GNUTLS_E_PREMATURE_TERMINATION);
  }
  const chain = judgeChain(request.tls.requireCert, facts.certificate, facts.verification);
  if (chain.ok === false) {
    host.detach();
    return reportFailure(request, chain);
  }
  if (facts.certificate !== null) {
    const peer = judgePeer(request.tls, hostName, facts.certificate, await host.localFqdn());
    if (peer.ok === false) {
      host.detach();
      return reportFailure(request, peer);
    }
  }
  return { ok: true };
}
