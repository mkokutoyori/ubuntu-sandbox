/**
 * DomainTypes — client-side domain-join state (PRD-Windows-Server.md §5
 * P6). `DomainMembership` is what `Add-Computer`/`netdom join` leave
 * behind on a joined machine; `DomainSession` is what a successful
 * domain logon (`LAB\alice`/`alice@lab.local`) leaves behind for the
 * duration of that logon (consumed by `whoami`, and by SMB/WinRM domain
 * authentication).
 */

export interface DomainMembership {
  readonly dnsName: string;
  readonly netbiosName: string;
  /** Hostname or IP this machine dials to reach a DC for LDAP — no DNS SRV discovery yet (P7 dependency), always the address given to `Add-Computer -Server`/`netdom join /Server:`. */
  readonly dcAddress: string;
  /** This computer's own AD computer-account password (real AD's machine account secret). */
  readonly machineSecret: string;
}

export interface DomainSession {
  readonly netbiosName: string;
  readonly sam: string;
  /** Domain group sAMAccountNames the session's user is a direct member of. */
  readonly groups: string[];
}

/**
 * Resolve a `DOMAIN\user` or `user@dns.name` identity down to a bare sam,
 * but only when the domain/netbios part matches the machine's actual
 * joined domain — an unqualified or non-matching name returns null so
 * callers can fall back to local-account handling instead of silently
 * misrouting a local logon attempt into a domain dial.
 */
export function parseDomainQualifiedUser(raw: string, membership: DomainMembership): { sam: string } | null {
  const backslash = raw.indexOf('\\');
  if (backslash !== -1) {
    const netbios = raw.slice(0, backslash);
    const sam = raw.slice(backslash + 1);
    if (netbios.toLowerCase() === membership.netbiosName.toLowerCase() && sam) return { sam };
    return null;
  }
  const at = raw.indexOf('@');
  if (at !== -1) {
    const sam = raw.slice(0, at);
    const dns = raw.slice(at + 1);
    if (dns.toLowerCase() === membership.dnsName.toLowerCase() && sam) return { sam };
    return null;
  }
  return null;
}
