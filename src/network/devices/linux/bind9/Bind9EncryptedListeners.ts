import { simulationNowMs } from '@/network/core/SystemClock';
import type { EndHost } from '@/network/devices/EndHost';
import { bindDnsTlsServer, unbindDnsTlsServer } from '@/network/dns/transport/DnsTlsTransport';
import {
  bindDnsHttpServer, bindDnsHttpsServer, unbindDnsHttpServer, unbindDnsHttpsServer,
} from '@/network/dns/transport/DnsHttpsTransport';
import type { DnsStreamHandler } from '@/network/dns/transport/DnsTcpTransport';
import type { ServerIdentity } from '@/network/http/https/ServerTlsToolkit';
import { generateSelfSignedCertificate } from '@/network/pki/SelfSignedCertificate';
import { pemToCertChain, pemToPrivateKey } from '@/network/pki/pem';
import { privateKeyPairsWith } from '@/network/pki/keyPairing';
import type { OperationResult } from '../LinuxServiceManager';
import type { AclHostEnvironment } from './NamedAcl';
import type { NamedListener, NamedTlsProfile } from './NamedConfig';

const ANY_ADDRESS = '0.0.0.0';
const LOOPBACK = '127.0.0.1';
const TLS_ERROR = 'loading configuration: TLS error';
const NOT_FOUND = 'loading configuration: not found';
const SYSTEM_LIB = 'error:0A080002:SSL routines::system lib';
const PEM_LIB = 'error:0A080009:SSL routines::PEM lib';
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

function isFailure(value: ServerIdentity | PreparedFailure | null): value is PreparedFailure {
  return value !== null && 'ok' in value;
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
      if (listener.ipv6) continue;
      const identity = this.identityOf(listener);
      if (isFailure(identity)) return identity;
      bound.push({ listener, identity, addresses: this.addressesOf(listener) });
    }
    return { ok: true as const, bound };
  }

  bind(prepared: PreparedListeners): OperationResult {
    try {
      for (const { listener, identity, addresses } of prepared.bound) {
        for (const address of addresses) this.bindOne(listener, identity, address);
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

  private bindOne(listener: NamedListener, identity: ServerIdentity | null, address: string): void {
    const { host, handler, processName } = this.deps;
    const common = { port: listener.port, address, processName };
    const protocols = listener.tls.kind === 'profile' ? listener.tls.profile.protocols ?? undefined : undefined;
    if (listener.http === null) {
      bindDnsTlsServer(host, handler, { ...common, identity: identity!, ...(protocols ? { protocols } : {}) });
      this.undo.push(() => unbindDnsTlsServer(host, listener.port, address));
    } else if (identity === null) {
      bindDnsHttpServer(host, handler, { ...common, paths: listener.http.endpoints });
      this.undo.push(() => unbindDnsHttpServer(host, listener.port, address));
    } else {
      bindDnsHttpsServer(
        host, handler,
        { serverCert: identity.cert, serverPrivateKey: identity.key, serverChain: identity.chain, ...(protocols ? { protocols } : {}) },
        { ...common, paths: listener.http.endpoints },
      );
      this.undo.push(() => unbindDnsHttpsServer(host, listener.port, address));
    }
  }

  private addressesOf(listener: NamedListener): readonly string[] {
    if (listener.addresses.matchesEveryAddress()) return [ANY_ADDRESS];
    const environment = this.deps.environment();
    return [LOOPBACK, ...environment.localAddresses].filter(
      (address, index, all) => all.indexOf(address) === index && listener.addresses.matches(address, environment),
    );
  }

  private identityOf(listener: NamedListener): ServerIdentity | PreparedFailure | null {
    if (listener.tls.kind === 'none') return null;
    if (listener.tls.kind === 'ephemeral') {
      const generated = generateSelfSignedCertificate(`CN=${this.deps.host.getHostname()}`, { now: simulationNowMs() });
      return { cert: generated.cert, key: generated.privateKey, chain: [] };
    }
    return this.profileIdentity(listener.tls.profile);
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
