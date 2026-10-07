import type { CertificateVerifier } from '@/network/pki/CertificateVerifier';
import type { X509Certificate } from '@/network/pki/X509Certificate';
import type { PkiPrivateKey } from '@/network/pki/PkiKeyPair';
import {
  pemToCertChain, pemToPrivateKey, pemToEncryptedPrivateKey, isEncryptedPrivateKeyPem,
} from '@/network/pki/pem';
import { privateKeyPairsWith } from '@/network/pki/keyPairing';
import { resolveCipherList, type TlsProtocolVersion } from '@/network/tls/legacy/legacyCipherSuites';
import { applySslConfCommand, createSslConfState, effectiveProtocols, formatSslConfError } from '@/network/tls/legacy/sslConf';
import {
  anchorsFromPem, buildClientVerifier, crlsFromPem, ticketKeyFromFile, type ServerIdentity,
} from '@/network/http/https/ServerTlsToolkit';
import { OcspClient, WireOcspResponder, DEFAULT_OCSP_POLICY, ocspUrlOf, type OcspWireDeps } from '@/network/http/ocsp/OcspHttpClient';
import type { OcspStapleSource } from '@/network/tls/ocspStapling';
import type { ApacheVirtualHost } from './ApacheConfig';
import { contiguousProtocols, type ApacheProtocol, type ApacheSslSettings } from './ApacheSsl';

export interface ApacheTlsFiles {
  read(path: string): string | null;
  list(dir: string): string[] | null;
}

export interface ApacheTlsProblem { readonly error: string }

export function isApacheTlsProblem(value: unknown): value is ApacheTlsProblem {
  return typeof value === 'object' && value !== null && 'error' in value;
}

export interface ApacheVhostTls {
  readonly vhost: ApacheVirtualHost;
  readonly settings: ApacheSslSettings;
  readonly identity: ServerIdentity;
  readonly verifier: CertificateVerifier | null;
  readonly protocols: readonly TlsProtocolVersion[];
  readonly protocolSet: boolean;
  readonly cipherList: string;
  readonly tls13Ciphersuites: string | undefined;
  readonly groups: readonly string[] | undefined;
  readonly preferServerCiphers: boolean;
  readonly sessionTickets: boolean;
  readonly ticketKey: Uint8Array | undefined;
  readonly extendedMasterSecret: boolean | undefined;
  readonly staple: OcspStapleSource | undefined;
  readonly warnings: readonly string[];
  readonly fingerprint: string;
}

const PROTOCOL_VERSION: Readonly<Record<ApacheProtocol, TlsProtocolVersion | null>> = {
  SSLv3: null, TLSv1: '1.0', 'TLSv1.1': '1.1', 'TLSv1.2': '1.2', 'TLSv1.3': '1.3',
};

export function vhostIdentifier(vhost: ApacheVirtualHost): string {
  return `${vhost.serverName ?? '*'}:${vhost.port}`;
}

export function loadVhostTls(
  vhost: ApacheVirtualHost, files: ApacheTlsFiles, protocolSetByVhost: boolean, wire: OcspWireDeps | null = null,
): ApacheVhostTls | ApacheTlsProblem {
  const settings = vhost.ssl;
  const id = vhostIdentifier(vhost);
  const fail = (error: string): ApacheTlsProblem => ({ error });

  const protocols = contiguousProtocols(settings.protocols);
  if (protocols.length === 0) return fail('AH02231: No SSL protocols available [hint: SSLProtocol]');

  const cipherSource = settings.cipherSuite ?? DEFAULT_CIPHERS;
  const cipherList = resolveCipherList(cipherSource);
  if (cipherList.ok === false) {
    return fail(`AH01898: Unable to configure permitted SSL ciphers\nSSL Library Error: ${cipherList.error}`);
  }

  if (settings.certificateFiles.length === 0) {
    return fail(`AH02572: Failed to configure at least one certificate and key for ${id}`);
  }

  const certFile = settings.certificateFiles[0];
  const certPem = files.read(certFile);
  if (certPem === null) {
    return fail(`AH00526: Syntax error on line 1 of ${vhost.source}: `
      + `SSLCertificateFile: file '${certFile}' does not exist or is empty`);
  }
  const certificates = pemToCertChain(certPem);
  if (certificates.length === 0) {
    return fail(`AH02561: Failed to configure certificate ${id}, check ${certFile}\n`
      + 'SSL Library Error: error:0480006C:PEM routines::no start line');
  }
  let chain = certificates.slice(1);
  if (chain.length === 0 && settings.certificateChainFile !== null) {
    const chainPem = files.read(settings.certificateChainFile);
    if (chainPem === null) {
      return fail(`AH00526: Syntax error on line 1 of ${vhost.source}: `
        + `SSLCertificateChainFile: file '${settings.certificateChainFile}' does not exist or is empty`);
    }
    chain = pemToCertChain(chainPem);
  }

  const keyFile = settings.certificateKeyFiles[0] ?? certFile;
  const keyPem = keyFile === certFile ? certPem : files.read(keyFile);
  if (keyPem === null) {
    return fail(`AH00526: Syntax error on line 1 of ${vhost.source}: `
      + `SSLCertificateKeyFile: file '${keyFile}' does not exist or is empty`);
  }
  let key: PkiPrivateKey | null;
  if (isEncryptedPrivateKeyPem(keyPem)) {
    key = null;
    return fail('AH02578: Init: Unable to read pass phrase [Hint: key introduced or changed before restart?]\n'
      + `AH02564: Failed to configure encrypted (?) private key ${id}, check ${keyFile}`);
  }
  key = pemToPrivateKey(keyPem);
  if (!key) {
    return fail(`AH02564: Failed to configure encrypted (?) private key ${id}, check ${keyFile}\n`
      + 'SSL Library Error: error:0480006C:PEM routines::no start line');
  }
  if (!privateKeyPairsWith(certificates[0].publicKey, key)) {
    return fail(`AH02565: Certificate and private key ${id} from ${certFile} and ${keyFile} do not match`);
  }

  let verifier: CertificateVerifier | null = null;
  const verifiesSomewhere = settings.verifyClient !== 'none'
    || vhost.directoryAuth.some((entry) => entry.verifyClient !== null && entry.verifyClient !== 'none');
  if (verifiesSomewhere) {
    const anchorTexts: string[] = [];
    if (settings.caCertificateFile !== null) {
      const text = files.read(settings.caCertificateFile);
      if (text !== null) anchorTexts.push(text);
    }
    if (settings.caCertificatePath !== null) {
      for (const name of files.list(settings.caCertificatePath) ?? []) {
        const text = files.read(`${settings.caCertificatePath}/${name}`);
        if (text !== null) anchorTexts.push(text);
      }
    }
    const crlTexts: string[] = [];
    if (settings.caRevocationFile !== null) {
      const text = files.read(settings.caRevocationFile);
      if (text !== null) crlTexts.push(text);
    }
    if (settings.caRevocationPath !== null) {
      for (const name of files.list(settings.caRevocationPath) ?? []) {
        const text = files.read(`${settings.caRevocationPath}/${name}`);
        if (text !== null) crlTexts.push(text);
      }
    }
    const crlChecking = settings.crlCheck.mode !== 'none';
    if (crlChecking && settings.caRevocationFile === null && settings.caRevocationPath === null) {
      return fail(`AH01899: Host ${id}: CRL checking has been enabled, but neither SSLCARevocationFile `
        + 'nor SSLCARevocationPath is configured');
    }
    const anchors = anchorsFromPem(...anchorTexts);
    let responderTrust = anchors;
    if (settings.ocspResponderCertificateFile !== null) {
      const text = files.read(settings.ocspResponderCertificateFile);
      if (text !== null) responderTrust = [...anchors, ...anchorsFromPem(text)];
    }
    const ocsp = settings.ocsp.mode !== 'off' && wire
      ? {
        responder: new WireOcspResponder(new OcspClient(wire, {
          ...DEFAULT_OCSP_POLICY, responderUrl: settings.ocspDefaultResponder,
          overrideResponder: settings.ocspOverrideResponder, trusted: responderTrust,
          verifySignature: !settings.ocspNoVerify, useNonce: settings.ocspUseRequestNonce,
          cacheMs: 0, timeoutMs: settings.ocspResponderTimeout * 1000, proxyUrl: settings.ocspProxyUrl,
          skewMs: settings.ocspResponseTimeSkew * 1000,
          maxAgeMs: settings.ocspResponseMaxAge < 0 ? null : settings.ocspResponseMaxAge * 1000,
        })),
        scope: settings.ocsp.mode, missingOk: settings.ocsp.noOcspForCertOk,
      }
      : undefined;
    verifier = buildClientVerifier({
      anchors, crls: crlTexts.flatMap((text) => crlsFromPem(text)), crlChecking,
      revocationScope: settings.crlCheck.mode === 'leaf' ? 'leaf' : 'chain',
      missingCrlOk: settings.crlCheck.noCrlForCertOk, maxDepth: settings.verifyDepth, ocsp,
    });
  }

  let ticketKey: Uint8Array | undefined;
  if (settings.sessionTicketKeyFile !== null) {
    const text = files.read(settings.sessionTicketKeyFile);
    if (text !== null) {
      if (text.length !== 48) {
        return fail(`AH02289: Configuration of the session ticket key file ${settings.sessionTicketKeyFile} failed: `
          + 'it must contain exactly 48 bytes');
      }
      ticketKey = ticketKeyFromFile(text);
    }
  }

  const warnings: string[] = [];
  let staple: OcspStapleSource | undefined;
  if (settings.useStapling) {
    if (settings.stapling.cache === null) {
      return fail('AH01958: SSLStapling: no stapling cache available');
    }
    const issuer = chain.find((c) => c.subject === certificates[0].issuer);
    const url = settings.staplingForceUrl ?? ocspUrlOf(certificates[0]);
    if (!issuer) {
      warnings.push("AH02217: ssl_stapling_init_cert: can't retrieve issuer certificate!");
      warnings.push(`AH02604: Unable to configure certificate ${id}:0 for stapling`);
    } else if (url === null) {
      warnings.push(`AH02218: ssl_stapling_init_cert: no OCSP URI in certificate and no SSLStaplingForceURL set`);
      warnings.push(`AH02604: Unable to configure certificate ${id}:0 for stapling`);
    } else if (wire) {
      const client = new OcspClient(wire, {
        ...DEFAULT_OCSP_POLICY, responderUrl: url, overrideResponder: true, trusted: [issuer],
        useNonce: false, verifySignature: false, skewMs: settings.staplingResponseTimeSkew * 1000,
        maxAgeMs: settings.staplingResponseMaxAge < 0 ? null : settings.staplingResponseMaxAge * 1000,
        cacheMs: settings.staplingStandardCacheTimeout * 1000,
        timeoutMs: settings.staplingResponderTimeout * 1000, proxyUrl: settings.ocspProxyUrl,
      });
      const policy = {
        returnErrors: settings.staplingReturnResponderErrors, fakeTryLater: settings.staplingFakeTryLater,
        errorCacheMs: settings.staplingErrorCacheTimeout * 1000,
      };
      staple = (cert) => client.stapleFor(cert, issuer, policy);
    }
  }

  const state = createSslConfState();
  for (const [command, value] of settings.confCommands) {
    const outcome = applySslConfCommand(state, command, value, { mode: 'file', server: true });
    if (outcome.ok === false) {
      return fail(`AH02544: Unable to configure the OpenSSL command '${command}' with value '${value}'\n`
        + `SSL Library Error: ${formatSslConfError(outcome.errors)}`);
    }
  }
  let finalCipherList = cipherSource;
  if (state.cipherString !== null) {
    const override = resolveCipherList(`${state.cipherString}:!aNULL:!eNULL:!EXP`);
    if (override.ok === false) {
      return fail(`AH02544: Unable to configure the OpenSSL command 'CipherString'\nSSL Library Error: ${override.error}`);
    }
    finalCipherList = `${state.cipherString}:!aNULL:!eNULL:!EXP`;
  }
  const baseVersions = protocols.map((name) => PROTOCOL_VERSION[name]).filter((v): v is TlsProtocolVersion => v !== null);
  const finalProtocols = effectiveProtocols(baseVersions, state);
  const sessionTickets = state.sessionTicket ?? settings.sessionTickets;
  const preferServerCiphers = state.serverPreference ?? settings.honorCipherOrder;

  const fingerprint = [
    certificates[0].serialNumber, certificates[0].notAfter, key.material, finalProtocols.join(','), finalCipherList,
    preferServerCiphers, sessionTickets, settings.sessionCacheTimeout, settings.sessionCache, settings.verifyClient,
    settings.verifyDepth, state.tls13Ciphersuites ?? settings.tls13Ciphers ?? '', (state.groups ?? []).join(','),
    ticketKey ? ticketKey.join('.') : '', settings.crlCheck.mode, settings.caRevocationFile ?? '',
    settings.useStapling, settings.ocsp.mode, settings.ocspDefaultResponder ?? '', settings.staplingForceUrl ?? '',
  ].join('|');

  return {
    vhost, settings, identity: { cert: certificates[0], key, chain }, verifier, protocols: finalProtocols,
    protocolSet: protocolSetByVhost, cipherList: finalCipherList,
    tls13Ciphersuites: state.tls13Ciphersuites ?? settings.tls13Ciphers ?? undefined,
    groups: state.groups ?? undefined, preferServerCiphers, sessionTickets, ticketKey,
    extendedMasterSecret: state.extendedMasterSecret ?? undefined, staple, warnings, fingerprint,
  };
}

const DEFAULT_CIPHERS = 'ALL:!COMPLEMENTOFDEFAULT:!eNULL:!aNULL:!eNULL:!EXP';

export type { X509Certificate };

export function sslCompatible(
  port: { readonly vhosts: readonly { readonly vhost: ApacheVirtualHost; readonly tls: ApacheVhostTls }[] },
  first: ApacheVirtualHost, second: ApacheVirtualHost,
): boolean {
  const a = port.vhosts.find((e) => e.vhost === first)?.tls;
  const b = port.vhosts.find((e) => e.vhost === second)?.tls;
  if (!a || !b) return false;
  const sameProtocols = a.protocols.join(',') === b.protocols.join(',');
  const sameCiphers = a.cipherList === b.cipherList;
  const sameAuth = a.settings.verifyClient === b.settings.verifyClient
    && a.settings.verifyDepth === b.settings.verifyDepth
    && a.settings.caCertificateFile === b.settings.caCertificateFile
    && a.settings.caCertificatePath === b.settings.caCertificatePath
    && a.settings.caDnRequestFile === b.settings.caDnRequestFile;
  return sameProtocols && sameCiphers && sameAuth;
}
