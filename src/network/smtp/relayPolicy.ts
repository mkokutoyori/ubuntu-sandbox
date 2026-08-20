export function isLocalDomain(domain: string, localDomains: ReadonlySet<string>): boolean {
  return localDomains.has(domain.toLowerCase());
}

export function isPostmasterAddress(address: string): boolean {
  const at = address.indexOf('@');
  const localPart = at === -1 ? address : address.slice(0, at);
  return localPart.toLowerCase() === 'postmaster';
}

export type RcptDecision = 'accept-local' | 'accept-postmaster' | 'accept-authenticated-relay' | 'deny-relay';

export function evaluateRcpt(address: string, localDomains: ReadonlySet<string>, authenticated: boolean): RcptDecision {
  if (isPostmasterAddress(address)) return 'accept-postmaster';
  const at = address.indexOf('@');
  const domain = at === -1 ? '' : address.slice(at + 1);
  if (domain !== '' && isLocalDomain(domain, localDomains)) return 'accept-local';
  return authenticated ? 'accept-authenticated-relay' : 'deny-relay';
}
