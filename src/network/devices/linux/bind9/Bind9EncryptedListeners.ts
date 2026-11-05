import { simulationNowMs } from '@/network/core/SystemClock';
import type { EndHost } from '@/network/devices/EndHost';
import { bindDnsTlsServer, unbindDnsTlsServer } from '@/network/dns/transport/DnsTlsTransport';
import {
  bindDnsHttpServer, bindDnsHttpsServer, unbindDnsHttpServer, unbindDnsHttpsServer,
} from '@/network/dns/transport/DnsHttpsTransport';
import type { DnsStreamHandler } from '@/network/dns/transport/DnsTcpTransport';
import type { ServerIdentity } from '@/network/http/https/ServerTlsToolkit';
import { generateSelfSignedCertificate } from '@/network/pki/SelfSignedCertificate';
import { pemToCertChain, pemToDhParameters, pemToPrivateKey } from '@/network/pki/pem';
import type { DnsTlsServerSettings } from '@/network/dns/transport/DnsTlsServerSettings';
import type { X509Certificate } from '@/network/pki/X509Certificate';
import { privateKeyPairsWith } from '@/network/pki/keyPairing';
import type { OperationResult } from '../LinuxServiceManager';
import type { AclHostEnvironment } from './NamedAcl';
import type { NamedListener, NamedTlsProfile } from './NamedConfig';
import { listenAddresses } from './Bind9ListenAddresses';
import { DEFAULT_LISTENER_CLIENTS, UNLIMITED_STREAMS_PER_CONNECTION } from './NamedTlsConfig';

const TLS_ERROR = 'loading configuration: TLS error';
const NOT_FOUND = 'loading configuration: not found';
const SYSTEM_LIB = 'error:0A080002:SSL routines::system lib';
const PEM_LIB = 'error:0A080009:SSL routines::PEM lib';
const LOADING_FAILURE = 'loading configuration: failure';
const NO_SUCH_FILE = 'Error initializing TLS context: error:80000002:system library::No such file or directory';

export interface EncryptedListenerDeps {
  readonly host: EndHost;
  readonly processName: string;
  readonly handler: DnsStreamHandler;
  readonly readFile: (path: string) => string | null;
  readonly log: (message: string) => void;
  readonly environment: () => AclHostEnvironment;
}

interface BoundListener {
  readonly listener: NamedListener;
  readonly identity: ServerIdentity | null;
  readonly settings: DnsTlsServerSettings | undefined;
  readonly addresses: readonly string[];
}

interface PreparedFailure {
  readonly ok: false;
  readonly error: string;
  readonly lines: readonly string[];
}

export interface PreparedListeners {
  readonly ok: true;
  readonly bound: readonly BoundListener[];
}

export type PreparedEncryptedListeners = PreparedListeners | PreparedFailure;

function withIssuers(identity: ServerIdentity, anchors: readonly X509Certificate[]): ServerIdentity {
  const chain = [...identity.chain];
  let current = chain.length > 0 ? chain[chain.length - 1] : identity.cert;
  while (current.subject !== current.issuer) {
    const issuer = anchors.find((anchor) => anchor.subject === current.issuer);
    if (issuer === undefined || chain.includes(issuer)) break;
    chain.push(issuer);
    current = issuer;
  }
  return { ...identity, chain };
}

function isFailure(value: ServerIdentity | DnsTlsServerSettings | PreparedFailure | null | undefined): value is PreparedFailure {
  return value !== null && value !== undefined && 'ok' in value;
}

function tlsFailure(lines: readonly string[]): PreparedFailure {
  return { ok: false, error: TLS_ERROR, lines };
}

function certificateFailure(path: string, system: boolean, detail: string): PreparedFailure {
  return tlsFailure([
    `SSL_CTX_use_certificate_chain_file: '${path}' failed: ${system ? SYSTEM_LIB : PEM_LIB}`,
    system ? NO_SUCH_FILE : `Error initializing TLS context: ${detail}`,
  ]);
}

function keyFailure(path: string, kind: 'missing' | 'unreadable' | 'mismatch'): PreparedFailure {
  switch (kind) {
    case 'missing':
      return tlsFailure([`SSL_CTX_use_PrivateKey_file: '${path}' failed: ${SYSTEM_LIB}`, NO_SUCH_FILE]);
    case 'unreadable':
      return tlsFailure([
        `SSL_CTX_use_PrivateKey_file: '${path}' failed: ${PEM_LIB}`,
        'Error initializing TLS context: error:1E08010C:DECODER routines::unsupported',
      ]);
    case 'mismatch':
      return tlsFailure([
        `SSL_CTX_use_PrivateKey_file: '${path}' failed: error:05800074:x509 certificate routines::key values mismatch`,
        'Error initializing TLS context: error:05800074:x509 certificate routines::key values mismatch',
      ]);
  }
}

export class Bind9EncryptedListeners {
  private undo: (() => void)[] = [];

  constructor(private readonly deps: EncryptedListenerDeps) {}

  prepare(listeners: readonly NamedListener[]): PreparedEncryptedListeners {
    const bound: BoundListener[] = [];
    for (const listener of listeners) {
      const identity = this.identityOf(listener);
      if (isFailure(identity)) return identity;
      const settings = this.settingsOf(listener);
      if (isFailure(settings)) return settings;
      const anchors = settings?.clientTrustAnchors;
      const presented = identity !== null && anchors !== undefined ? withIssuers(identity, anchors) : identity;
      bound.push({ listener, identity: presented, settings, addresses: listenAddresses(listener.addresses, listener.ipv6, this.deps.environment()) });
    }
    return { ok: true as const, bound };
  }

  bind(prepared: PreparedListeners): OperationResult {
    try {
      for (const { listener, identity, settings, addresses } of prepared.bound) {
        for (const address of addresses) this.bindOne(listener, identity, settings, address);
      }
    } catch {
      this.stop();
      return { ok: false, error: 'could not listen on TCP socket: address already in use' };
    }
    return { ok: true };
  }

  stop(): void {
    for (const undo of this.undo.splice(0)) undo();
  }

  private bindOne(listener: NamedListener, identity: ServerIdentity | null, settings: DnsTlsServerSettings | undefined, address: string): void {
    const { host, handler, processName } = this.deps;
    const common = { port: listener.port, address, processName };
    if (listener.http === null) {
      bindDnsTlsServer(host, handler, { ...common, identity: identity!, settings, requireAlpn: false, silentRejection: true });
      this.undo.push(() => unbindDnsTlsServer(host, listener.port, address));
      return;
    }
    const http = {
      ...common, paths: listener.http.endpoints,
      listenerClients: listener.http.listenerClients ?? DEFAULT_LISTENER_CLIENTS,
      ...(listener.http.streamsPerConnection === null ? {}
        : { streamsPerConnection: listener.http.streamsPerConnection === 0 ? UNLIMITED_STREAMS_PER_CONNECTION : listener.http.streamsPerConnection }),
    };
    if (identity === null) {
      bindDnsHttpServer(host, handler, http);
      this.undo.push(() => unbindDnsHttpServer(host, listener.port, address));
    } else {
      bindDnsHttpsServer(
        host, handler,
        { serverCert: identity.cert, serverPrivateKey: identity.key, serverChain: identity.chain, settings },
        { ...http, silentRejection: true },
      );
      this.undo.push(() => unbindDnsHttpsServer(host, listener.port, address));
    }
  }

  private identityOf(listener: NamedListener): ServerIdentity | PreparedFailure | null {
    if (listener.tls.kind === 'none') return null;
    if (listener.tls.kind === 'ephemeral') {
      const generated = generateSelfSignedCertificate(`CN=${this.deps.host.getHostname()}`, { now: simulationNowMs() });
      return { cert: generated.cert, key: generated.privateKey, chain: [] };
    }
    return this.profileIdentity(listener.tls.profile);
  }

  private settingsOf(listener: NamedListener): DnsTlsServerSettings | PreparedFailure | undefined {
    if (listener.tls.kind === 'none') return undefined;
    if (listener.tls.kind === 'ephemeral') return {};
    const profile = listener.tls.profile;
    const loadingFailure: PreparedFailure = { ok: false, error: LOADING_FAILURE, lines: [] };
    let clientTrustAnchors: DnsTlsServerSettings['clientTrustAnchors'];
    if (profile.caFile !== null) {
      const text = this.deps.readFile(profile.caFile);
      const anchors = text === null ? [] : pemToCertChain(text);
      if (anchors.length === 0) return loadingFailure;
      clientTrustAnchors = anchors;
    }
    let dhParameters: DnsTlsServerSettings['dhParameters'];
    if (profile.dhparamFile !== null) {
      const text = this.deps.readFile(profile.dhparamFile);
      const parsed = text === null ? null : pemToDhParameters(text);
      if (parsed === null) return loadingFailure;
      dhParameters = parsed;
    }
    return {
      ...(profile.protocols === null ? {} : { protocols: profile.protocols }),
      ciphers: profile.ciphers,
      preferServerCiphers: profile.preferServerCiphers === true,
      sessionTickets: profile.sessionTickets !== false,
      ...(dhParameters === undefined ? {} : { dhParameters }),
      ...(clientTrustAnchors === undefined ? {} : { clientTrustAnchors }),
    };
  }

  private profileIdentity(profile: NamedTlsProfile): ServerIdentity | PreparedFailure {
    if (profile.certFile === null || profile.keyFile === null) return { ok: false, error: NOT_FOUND, lines: [] };
    const certText = this.deps.readFile(profile.certFile);
    if (certText === null) return certificateFailure(profile.certFile, true, '');
    const chain = pemToCertChain(certText);
    if (chain.length === 0) return certificateFailure(profile.certFile, false, 'error:0480006C:PEM routines::no start line');
    const keyText = this.deps.readFile(profile.keyFile);
    if (keyText === null) return keyFailure(profile.keyFile, 'missing');
    const key = pemToPrivateKey(keyText);
    if (key === null) return keyFailure(profile.keyFile, 'unreadable');
    if (!privateKeyPairsWith(chain[0].publicKey, key)) return keyFailure(profile.keyFile, 'mismatch');
    return { cert: chain[0], key, chain: chain.slice(1) };
  }
}
