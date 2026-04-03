/**
 * Windows whoami command — displays user, group, and privilege information.
 *
 * Supports flags: /user, /groups, /priv, /all
 * Outputs match the real Windows whoami format.
 */

import type { WindowsUserManager } from './WindowsUserManager';

export interface WhoamiContext {
  hostname: string;
  userManager: WindowsUserManager;
}

export function cmdWhoami(ctx: WhoamiContext, args: string[]): string {
  const username = ctx.userManager.currentUser;
  const flag = args.length > 0 ? args[0].toLowerCase() : '';

  if (!flag) {
    return `${ctx.hostname.toLowerCase()}\\${username.toLowerCase()}`;
  }

  switch (flag) {
    case '/user':
      return formatUserInfo(ctx, username);
    case '/groups':
      return formatGroupInfo(ctx, username);
    case '/priv':
      return formatPrivilegeInfo(ctx, username);
    case '/all':
      return [
        formatUserInfo(ctx, username),
        '',
        formatGroupInfo(ctx, username),
        '',
        formatPrivilegeInfo(ctx, username),
      ].join('\n');
    default:
      return 'ERROR: Invalid argument/option - \'' + args[0] + '\'.\nType "WHOAMI /?" for usage.';
  }
}

function formatUserInfo(ctx: WhoamiContext, username: string): string {
  const sid = ctx.userManager.getUserSID(username) ?? 'S-1-5-21-0-0-0-0';
  const lines: string[] = [];
  lines.push('');
  lines.push('USER INFORMATION');
  lines.push('----------------');
  lines.push('');
  lines.push('User Name' + ' '.repeat(24) + 'SID');
  lines.push('=' .repeat(33) + ' ' + '='.repeat(47));
  lines.push(
    `${ctx.hostname.toLowerCase()}\\${username.toLowerCase()}`.padEnd(33) + ' ' + sid
  );
  return lines.join('\n');
}

function formatGroupInfo(ctx: WhoamiContext, username: string): string {
  const groups = ctx.userManager.getGroupsForUser(username);
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
