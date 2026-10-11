import type { GnutlsPriority } from './GnutlsPriority';

export interface ClientHelloOffer {
  readonly suiteCodes: readonly number[];
  readonly supportedVersions: readonly number[];
  readonly groupNames: readonly string[];
  readonly groupCodes: readonly number[];
  readonly keyShareCodes: readonly number[];
  readonly signatureCodes: readonly number[];
}

const VERSION_CODES: Readonly<Record<string, number>> = { 'VERS-TLS1.3': 0x0304, 'VERS-TLS1.2': 0x0303 };

const GROUP_CODES: Readonly<Record<string, number>> = {
  'GROUP-SECP192R1': 19, 'GROUP-SECP224R1': 21, 'GROUP-SECP256R1': 23, 'GROUP-SECP384R1': 24, 'GROUP-SECP521R1': 25,
  'GROUP-X25519': 29, 'GROUP-X448': 30, 'GROUP-FFDHE2048': 256, 'GROUP-FFDHE3072': 257, 'GROUP-FFDHE4096': 258,
  'GROUP-FFDHE6144': 259, 'GROUP-FFDHE8192': 260, 'GROUP-GC256B': 0x23, 'GROUP-GC512A': 0x26,
};

const SIGNATURE_CODES: Readonly<Record<string, number>> = {
  'SIGN-RSA-SHA256': 0x0401, 'SIGN-RSA-SHA384': 0x0501, 'SIGN-RSA-SHA512': 0x0601, 'SIGN-RSA-SHA1': 0x0201,
  'SIGN-RSA-PSS-RSAE-SHA256': 0x0804, 'SIGN-RSA-PSS-RSAE-SHA384': 0x0805, 'SIGN-RSA-PSS-RSAE-SHA512': 0x0806,
  'SIGN-RSA-PSS-SHA256': 0x0809, 'SIGN-RSA-PSS-SHA384': 0x080a, 'SIGN-RSA-PSS-SHA512': 0x080b,
  'SIGN-ECDSA-SHA256': 0x0403, 'SIGN-ECDSA-SECP256R1-SHA256': 0x0403, 'SIGN-ECDSA-SHA384': 0x0503,
  'SIGN-ECDSA-SECP384R1-SHA384': 0x0503, 'SIGN-ECDSA-SHA512': 0x0603, 'SIGN-ECDSA-SECP521R1-SHA512': 0x0603,
  'SIGN-ECDSA-SHA1': 0x0203, 'SIGN-DSA-SHA1': 0x0202, 'SIGN-EdDSA-Ed25519': 0x0807, 'SIGN-EdDSA-Ed448': 0x0808,
  'SIGN-GOSTR341012-256': 0x0840, 'SIGN-GOSTR341012-512': 0x0841,
};

function keyAgreementClass(group: string): string {
  if (group.startsWith('GROUP-SECP')) return 'x962';
  if (group.startsWith('GROUP-FFDHE')) return 'dh';
  if (group.startsWith('GROUP-GC')) return 'gost';
  return group;
}

function keyShareGroups(groups: readonly string[]): string[] {
  if (groups.length === 0) return [];
  const first = groups[0];
  const second = groups.find((group) => keyAgreementClass(group) !== keyAgreementClass(first));
  return second === undefined ? [first] : [first, second];
}

function withoutRepeatedNeighbours(values: readonly number[]): number[] {
  return values.filter((value, index) => index === 0 || values[index - 1] !== value);
}

export function clientHelloOffer(priority: GnutlsPriority): ClientHelloOffer {
  const tls13 = priority.protocols.includes('VERS-TLS1.3');
  const versions = priority.protocols.filter((version) => version in VERSION_CODES).map((version) => VERSION_CODES[version]);
  const groups = priority.negotiableGroups;
  if (priority.modifiers.includes('%NO_EXTENSIONS')) {
    return { suiteCodes: priority.offeredSuites.map((suite) => parseInt(suite.code, 16)), supportedVersions: [], groupNames: [], groupCodes: [], keyShareCodes: [], signatureCodes: [] };
  }
  return {
    suiteCodes: priority.offeredSuites.map((suite) => parseInt(suite.code, 16)),
    supportedVersions: tls13 ? versions : [],
    groupNames: groups.filter((group) => group in GROUP_CODES),
    groupCodes: groups.filter((group) => group in GROUP_CODES).map((group) => GROUP_CODES[group]),
    keyShareCodes: tls13 ? keyShareGroups(groups).map((group) => GROUP_CODES[group]) : [],
    signatureCodes: withoutRepeatedNeighbours(priority.signatures.filter((signature) => signature in SIGNATURE_CODES).map((signature) => SIGNATURE_CODES[signature])),
  };
}
