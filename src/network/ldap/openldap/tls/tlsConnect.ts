import { CertificateVerifier } from '@/network/pki/CertificateVerifier';
import type { X509Certificate } from '@/network/pki/X509Certificate';
import type { TlsClientConfig } from '@/network/tls/TlsClientSession';
import type { TlsUpgradeOutcome, TlsUpgradeRequest } from '../ldapChannel';
import { LdapDebug } from '../ldapLog';
import { gnutlsStrerror } from './gnutlsErrors';
import { initTlsContext, type TlsFiles } from './tlsContext';
import { judgeChain, judgePeer, type ChainVerification, type PeerVerdict } from './tlsPeerPolicy';

export interface TlsHandshakeFacts {
  readonly established: boolean;
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

export async function connectTls(request: TlsUpgradeRequest, host: TlsConnectHost): Promise<TlsUpgradeOutcome> {
  const hostName = request.serverName === '' ? 'localhost' : request.serverName;
  const initialised = initTlsContext(request.tls, host.files, request.debug);
  if (initialised.ok === false) {
    request.debug(LdapDebug.ANY, `TLS: init_def_ctx: ${initialised.errmsg}.\n`);
    return { ok: false, detail: null, errno: null };
  }
  const { context } = initialised;
  const config: TlsClientConfig = {
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
    const detail = gnutlsStrerror(UNKNOWN_ERROR);
    request.debug(LdapDebug.ANY, `TLS: can't connect: ${detail}.\n`);
    return { ok: false, detail, errno: null };
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
