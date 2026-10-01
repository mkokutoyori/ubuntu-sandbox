export type ClientCertPolicy = 'strict' | 'lenient' | 'optional' | 'optional_no_ca';

const TOLERATED_WITHOUT_CA: ReadonlySet<string> = new Set(['unknown']);

export function allowsMissingCertificate(policy: ClientCertPolicy | undefined): boolean {
  return policy !== undefined && policy !== 'strict';
}

export function continuesAfterVerificationFailure(policy: ClientCertPolicy | undefined, reason: string): boolean {
  if (policy === 'lenient') return true;
  return policy === 'optional_no_ca' && TOLERATED_WITHOUT_CA.has(reason);
}
