import { SshConnectionRequest } from '@/network/protocols/ssh/server/SshConnectionRequest';

export interface RemoteLoginFacts {
  readonly user: string;
  readonly password: string;
  readonly host: string;
  readonly port: number;
  readonly sourceIp: string;
  readonly sourceHostname: string;
}

type CredentialAuthority = {
  checkPassword?: (u: string, p: string) => boolean;
  userMgr?: { checkPassword?: (u: string, p: string) => boolean };
  tryDomainAuth?: (u: string, p: string) => { ok: boolean } | null;
  authenticateAdmin?: (u: string, p: string, source?: string) => boolean;
  getSshHost?: () => { evaluate?: (req: unknown) => { outcome: string } } | undefined;
};

export function verifyRemoteCredentials(
  device: unknown, facts: RemoteLoginFacts,
): boolean {
  const dev = device as CredentialAuthority | null | undefined;
  if (!dev) return false;
  if (typeof dev.tryDomainAuth === 'function') {
    const domain = dev.tryDomainAuth(facts.user, facts.password);
    if (domain !== null) return domain.ok;
  }
  if (typeof dev.checkPassword === 'function') {
    return dev.checkPassword(facts.user, facts.password);
  }
  if (typeof dev.userMgr?.checkPassword === 'function') {
    return dev.userMgr.checkPassword(facts.user, facts.password);
  }
  if (typeof dev.authenticateAdmin === 'function') {
    return dev.authenticateAdmin(facts.user, facts.password, facts.sourceIp);
  }
  if (typeof dev.getSshHost === 'function') {
    try {
      const request = SshConnectionRequest.create({
        requestedUser: facts.user,
        requestedHost: facts.host,
        requestedPort: facts.port,
        sourceIp: facts.sourceIp,
        sourceHostname: facts.sourceHostname,
        command: null,
        offeredAuthMethods: ['password'],
        credentials: { password: facts.password },
      });
      return dev.getSshHost()?.evaluate?.(request)?.outcome === 'accepted';
    } catch {
      return false;
    }
  }
  return false;
}
