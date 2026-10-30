/**
 * Windows whoami command — displays user, group, and privilege information.
 *
 * Supports flags: /user, /groups, /priv, /all
 * Outputs match the real Windows whoami format.
 */

import { invalidArgumentError } from './WinSwitchGuard';
import type { WindowsUserManager } from './WindowsUserManager';
import type { DomainSession } from './domain/DomainTypes';
import { renderTable, type TableColumn, type TableStyle } from '../shells/cli/TextTable';

const WHOAMI_TABLE: TableStyle = { gap: 1, rule: true, ruleChar: '=' };

interface GroupRow { name: string; type: string; sid: string; attributes: string }

const GROUP_COLUMNS: Array<TableColumn<GroupRow>> = [
  { header: 'Group Name', value: (r) => r.name },
  { header: 'Type', value: (r) => r.type },
  { header: 'SID', value: (r) => r.sid },
  { header: 'Attributes', value: (r) => r.attributes },
];

const PRIVILEGE_COLUMNS: Array<TableColumn<readonly [string, string, string]>> = [
  { header: 'Privilege Name', value: (r) => r[0] },
  { header: 'Description', value: (r) => r[1] },
  { header: 'State', value: (r) => r[2] },
];

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
      return invalidArgumentError('whoami', args[0]);
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
  lines.push(...renderTable([{ account, sid }], [
    { header: 'User Name', value: (r) => r.account },
    { header: 'SID', value: (r) => r.sid },
  ], WHOAMI_TABLE));
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
  const rows: GroupRow[] = [
    { name: 'Everyone', type: 'Well-known', sid: 'S-1-1-0', attributes: 'Mandatory group, Enabled by default' },
    { name: 'NT AUTHORITY\\Local account', type: 'Well-known', sid: 'S-1-5-113', attributes: 'Mandatory group, Enabled by default' },
  ];

  if (domain) {
    for (const group of domain.groups) {
      rows.push({
        name: `${domain.netbiosName}\\${group}`, type: 'Group',
        sid: domainSid(domain.netbiosName), attributes: 'Mandatory group, Enabled by default',
      });
    }
  } else {
    for (const group of ctx.userManager.getGroupsForUser(username)) {
      const owner = group.name.toLowerCase() === 'administrators' ? ', Enabled group, Group owner' : '';
      rows.push({
        name: `BUILTIN\\${group.name}`, type: 'Alias', sid: group.sid,
        attributes: `Mandatory group, Enabled by default${owner}`,
      });
    }
  }
  rows.push(integrityRow(ctx));
  lines.push(...renderTable(rows, GROUP_COLUMNS, WHOAMI_TABLE));
  return lines.join('\n');
}

function integrityRow(ctx: WhoamiContext): GroupRow {
  const high = ctx.userManager.isCurrentUserAdmin();
  const name = high ? 'Mandatory Label\\High Mandatory Level' : 'Mandatory Label\\Medium Mandatory Level';
  const sid = high ? 'S-1-16-12288' : 'S-1-16-8192';
  const attributes = high ? 'Mandatory group, Enabled by default, Enabled group' : 'Mandatory group, Enabled by default';
  return { name, type: 'Label', sid, attributes };
}

function formatPrivilegeInfo(ctx: WhoamiContext, username: string): string {
  const privileges = ctx.userManager.getPrivileges(username);
  const lines: string[] = [];
  lines.push('');
  lines.push('PRIVILEGES INFORMATION');
  lines.push('----------------------');
  lines.push('');
  lines.push(...renderTable(privileges, PRIVILEGE_COLUMNS, WHOAMI_TABLE));

  return lines.join('\n');
}
