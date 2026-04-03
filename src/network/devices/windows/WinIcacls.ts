/**
 * Windows icacls command — display and modify NTFS Access Control Lists.
 *
 * Supports:
 *   - icacls <path>                    → display ACLs
 *   - icacls <path> /grant user:(perm) → grant permissions
 *   - icacls <path> /deny user:(perm)  → deny permissions
 *   - icacls <path> /remove user       → remove all ACEs for user
 *
 * Permission tokens: F (Full), M (Modify), RX (Read & Execute), R (Read), W (Write)
 */

import type { WindowsFileSystem } from './WindowsFileSystem';
import type { WindowsUserManager } from './WindowsUserManager';
import type { WinACE } from './WindowsFileSystem';

export interface IcaclsContext {
  fs: WindowsFileSystem;
  cwd: string;
  userManager: WindowsUserManager;
}

export function cmdIcacls(ctx: IcaclsContext, args: string[]): string {
  if (args.length === 0) {
    return 'ERROR: No file name specified.\nUsage: ICACLS name [/grant[:r] user:perm] [/deny user:perm]\n              [/remove user] [/T] [/C] [/L] [/Q]';
  }

  const path = args[0];
  const absPath = ctx.fs.normalizePath(path, ctx.cwd);
  const entry = ctx.fs.resolve(absPath);

  if (!entry) {
    return `${path}: The system cannot find the file specified.`;
  }

  // Parse operation
  let i = 1;
  while (i < args.length) {
    const flag = args[i].toLowerCase();

    if (flag === '/grant' || flag === '/grant:r') {
      if (!ctx.userManager.isCurrentUserAdmin()) return `${path}: Access is denied.`;
      if (i + 1 >= args.length) return 'ERROR: Invalid parameter.';
      const spec = args[++i];
      const err = parseAndApplyACE(ctx.fs, absPath, spec, 'allow');
      if (err) return err;
      i++;
      continue;
    }

    if (flag === '/deny') {
      if (!ctx.userManager.isCurrentUserAdmin()) return `${path}: Access is denied.`;
      if (i + 1 >= args.length) return 'ERROR: Invalid parameter.';
      const spec = args[++i];
      const err = parseAndApplyACE(ctx.fs, absPath, spec, 'deny');
      if (err) return err;
      i++;
      continue;
    }

    if (flag === '/remove') {
      if (!ctx.userManager.isCurrentUserAdmin()) return `${path}: Access is denied.`;
      if (i + 1 >= args.length) return 'ERROR: Invalid parameter.';
      const principal = args[++i];
      ctx.fs.removeACEs(absPath, principal);
      i++;
      continue;
    }

    // Skip known flags that we don't fully implement
    if (flag === '/t' || flag === '/c' || flag === '/l' || flag === '/q') {
      i++;
      continue;
    }

    i++;
  }

  // If no operation flags were given, just display
  if (args.length === 1) {
    return formatACL(ctx.fs, absPath, path);
  }

  return `Successfully processed 1 files; Failed processing 0 files`;
}

function parseAndApplyACE(fs: WindowsFileSystem, absPath: string, spec: string, type: 'allow' | 'deny'): string | null {
  // spec = "User:(R)" or "BUILTIN\Users:(F)"
  const match = spec.match(/^([^:]+):\(([^)]+)\)$/);
  if (!match) return 'ERROR: Invalid parameter format. Expected user:(permission)';

  const principal = match[1];
  const permToken = match[2].toUpperCase();

  const validPerms = ['F', 'M', 'RX', 'R', 'W', 'D', 'N'];
  if (!validPerms.includes(permToken)) {
    return `ERROR: Invalid permission token '${permToken}'.`;
  }

  const permissions = expandPermToken(permToken);
  fs.addACE(absPath, { principal, type, permissions });
  return null;
}

function expandPermToken(token: string): string[] {
  switch (token) {
    case 'F': return ['FullControl'];
    case 'M': return ['Modify', 'Read', 'Write', 'Execute', 'Delete'];
    case 'RX': return ['ReadAndExecute', 'Read', 'Execute'];
    case 'R': return ['Read'];
    case 'W': return ['Write'];
    case 'D': return ['Delete'];
    case 'N': return ['None'];
    default: return [token];
  }
}

function permissionsToToken(perms: string[]): string {
  if (perms.includes('FullControl')) return 'F';
  if (perms.includes('Modify')) return 'M';
  if (perms.includes('ReadAndExecute')) return 'RX';
  if (perms.includes('Read') && perms.includes('Write')) return 'RW';
  if (perms.includes('Read')) return 'R';
  if (perms.includes('Write')) return 'W';
  if (perms.includes('Delete')) return 'D';
  return perms.join(',');
}

function formatACL(fs: WindowsFileSystem, absPath: string, displayPath: string): string {
  const acl = fs.getACL(absPath);
  const lines: string[] = [];
  lines.push(displayPath);

  if (acl.length === 0) {
    // Show default ACLs
    lines.push(`    BUILTIN\\Administrators:(F)`);
    lines.push(`    BUILTIN\\Users:(RX)`);
    lines.push(`    NT AUTHORITY\\SYSTEM:(F)`);
  } else {
    for (const ace of acl) {
      const token = permissionsToToken(ace.permissions);
      const denyStr = ace.type === 'deny' ? '(DENY)' : '';
      lines.push(`    ${ace.principal}:${denyStr}(${token})`);
    }
  }

  lines.push('');
  lines.push('Successfully processed 1 files; Failed processing 0 files');
  return lines.join('\n');
}
