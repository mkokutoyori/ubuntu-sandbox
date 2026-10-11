import { MANDATORY_CIPHER_SUITES } from '../cipherSuites';
import { legacySuiteByCode, type TlsProtocolVersion } from '../legacy/legacyCipherSuites';
import type { TlsClientConfig } from '../TlsClientSession';
import type { CipherSuite } from '../types';
import type { GnutlsPriority } from './GnutlsPriority';
import { clientHelloOffer } from './gnutlsClientOffer';

export type GnutlsClientConfig = Required<Pick<
TlsClientConfig, 'versions' | 'cipherSuites' | 'legacyCipherSuites' | 'supportedGroups' | 'signatureSchemes'
>>;

const VERSION_OF: Readonly<Record<string, TlsProtocolVersion>> = { 'VERS-TLS1.3': '1.3', 'VERS-TLS1.2': '1.2' };

const SIGNATURE_SCHEME_OF: Readonly<Record<number, string>> = {
  0x0804: 'rsa_pss_rsae_sha256', 0x0401: 'rsa_pkcs1_sha256', 0x0403: 'ecdsa_secp256r1_sha256',
};

function groupNameOf(group: string): string {
  return group.slice('GROUP-'.length).toLowerCase();
}

export function gnutlsClientConfig(priority: GnutlsPriority): GnutlsClientConfig {
  const offer = clientHelloOffer(priority);
  const mandatory: readonly string[] = MANDATORY_CIPHER_SUITES;
  const legacy: string[] = [];
  for (const suite of priority.offeredSuites) {
    const name = suite.minimumVersion === 'TLS1.3' ? undefined : legacySuiteByCode(parseInt(suite.code, 16))?.name;
    if (name !== undefined) legacy.push(name);
  }
  return {
    versions: priority.protocols.filter((version) => version in VERSION_OF).map((version) => VERSION_OF[version]),
    cipherSuites: priority.offeredSuites
      .filter((suite) => suite.minimumVersion === 'TLS1.3' && mandatory.includes(suite.name))
      .map((suite) => suite.name as CipherSuite),
    legacyCipherSuites: legacy,
    supportedGroups: offer.groupNames.filter((group) => !group.startsWith('GROUP-GC')).map(groupNameOf),
    signatureSchemes: offer.signatureCodes.filter((code) => code in SIGNATURE_SCHEME_OF).map((code) => SIGNATURE_SCHEME_OF[code]),
  };
}
