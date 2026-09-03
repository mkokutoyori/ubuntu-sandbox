/**
 * Windows whoami command — displays user, group, and privilege information.
 *
 * Supports flags: /user, /groups, /priv, /all
 * Outputs match the real Windows whoami format.
 */

import type { WindowsUserManager } from './WindowsUserManager';
import type { DomainSession } from './domain/DomainTypes';

export interface WhoamiContext {
  hostname: string;
  userManager: WindowsUserManager;
  /** Active domain logon (PRD-Windows-Server.md §5 P6) — when set (and its `sam` matches the current user), `whoami` reports `netbios\sam` and domain groups instead of the local `hostname\user` + local groups. */
  domainSession?: DomainSession | null;
  logonDomain?: string;
}

function accountName(ctx: WhoamiContext, username: string, domain: DomainSession | null): string {
  const scope = domain ? domain.netbiosName : (ctx.logonDomain || ctx.hostname);
  return `${scope}\\${username}`;
}

function activeDomain(ctx: WhoamiContext, username: string): DomainSession | null {
  return ctx.domainSession && ctx.domainSession.sam.toLowerCase() === username.toLowerCase() ? ctx.domainSession : null;
}

export function cmdWhoami(ctx: WhoamiContext, args: string[]): string {
  const username = ctx.userManager.currentUser;
  const flag = args.length > 0 ? args[0].toLowerCase() : '';
  const domain = activeDomain(ctx, username);

  if (!flag) {
    return accountName(ctx, username, domain);
  }

  switch (flag) {
    case '/user':
      return formatUserInfo(ctx, username, domain);
    case '/groups':
      return formatGroupInfo(ctx, username, domain);
    case '/priv':
      return formatPrivilegeInfo(ctx, username);
    case '/all':
      return [
        formatUserInfo(ctx, username, domain),
        '',
        formatGroupInfo(ctx, username, domain),
        '',
        formatPrivilegeInfo(ctx, username),
      ].join('\n');
    default:
      return 'ERROR: Invalid argument/option - \'' + args[0] + '\'.\nType "WHOAMI /?" for usage.';
  }
}

function formatUserInfo(ctx: WhoamiContext, username: string, domain: DomainSession | null): string {
  const sid = domain ? domainSid(domain.netbiosName) : (ctx.userManager.getUserSID(username) ?? 'S-1-5-21-0-0-0-0');
  const account = accountName(ctx, username, domain);
  const lines: string[] = [];
  lines.push('');
  lines.push('USER INFORMATION');
  lines.push('----------------');
  lines.push('');
  lines.push('User Name' + ' '.repeat(24) + 'SID');
  lines.push('=' .repeat(33) + ' ' + '='.repeat(47));
  lines.push(account.padEnd(33) + ' ' + sid);
  return lines.join('\n');
}

/** A stable-looking (but not cryptographically real) domain SID, derived from the netbios name — good enough for display purposes, matching PRD §2.2's simplified-Kerberos scope. */
function domainSid(netbiosName: string): string {
  let hash = 0;
  for (const ch of netbiosName.toLowerCase()) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
  return `S-1-5-21-${1000000 + (hash % 8999999)}-500`;
}

function formatGroupInfo(ctx: WhoamiContext, username: string, domain: DomainSession | null): string {
  const lines: string[] = [];
  lines.push('');
  lines.push('GROUP INFORMATION');
  lines.push('-----------------');
  lines.push('');
  lines.push(
    'Group Name'.padEnd(44) + 'Type'.padEnd(14) + 'SID'.padEnd(20) + 'Attributes'
  );
  lines.push(
    '='.repeat(44) + ' ' + '='.repeat(13) + ' ' + '='.repeat(48) + ' ' + '='.repeat(30)
  );

  // Always include well-known groups
  lines.push(
    'Everyone'.padEnd(44) + 'Well-known'.padEnd(14) + 'S-1-1-0'.padEnd(49) + 'Mandatory group, Enabled by default'
  );
  lines.push(
    'NT AUTHORITY\\Local account'.padEnd(44) + 'Well-known'.padEnd(14) + 'S-1-5-113'.padEnd(49) + 'Mandatory group, Enabled by default'
  );

  if (domain) {
    for (const group of domain.groups) {
      const groupDisplay = `${domain.netbiosName}\\${group}`;
      lines.push(
        groupDisplay.padEnd(44) + 'Group'.padEnd(14) + domainSid(domain.netbiosName).padEnd(49) + 'Mandatory group, Enabled by default'
      );
    }
    return lines.join('\n');
  }

  const groups = ctx.userManager.getGroupsForUser(username);
  for (const group of groups) {
    const groupDisplay = `BUILTIN\\${group.name}`;
    lines.push(
      groupDisplay.padEnd(44) + 'Alias'.padEnd(14) + group.sid.padEnd(49) + 'Mandatory group, Enabled by default'
    );
  }

  return lines.join('\n');
}

function formatPrivilegeInfo(ctx: WhoamiContext, username: string): string {
  const privileges = ctx.userManager.getPrivileges(username);
  const lines: string[] = [];
  lines.push('');
  lines.push('PRIVILEGES INFORMATION');
  lines.push('----------------------');
  lines.push('');
  lines.push(
    'Privilege Name'.padEnd(45) + 'Description'.padEnd(50) + 'State'
  );
  lines.push(
    '='.repeat(45) + ' ' + '='.repeat(50) + ' ' + '='.repeat(10)
  );

  for (const [name, desc, state] of privileges) {
    lines.push(
      name.padEnd(45) + desc.padEnd(50) + state
    );
  }

  return lines.join('\n');
}
