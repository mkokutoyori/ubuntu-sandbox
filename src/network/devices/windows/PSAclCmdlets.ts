import { parsePSArgs } from './psArgs';
import type { PSDeviceContext, PSObjectVar } from './PowerShellExecutor';

export interface PSAclContext {
  device: PSDeviceContext;
  cwd: string;
  sessionObjects: Map<string, PSObjectVar>;
}

export function handleGetAcl(ctx: PSAclContext, args: string[]): string {
    const fs = ctx.device.getFileSystem();
    const params = parsePSArgs(args);
    const target = params.get('path') || params.get('_positional') || '';
    if (!target) return "Get-Acl : Cannot bind argument to parameter 'Path' because it is an empty string.";

    const absPath = fs.normalizePath(target, ctx.cwd);
    if (!fs.exists(absPath)) return `Get-Acl : Cannot find path '${target}' because it does not exist.`;

    const owner = fs.getOwner(absPath);
    const acl = fs.getACL(absPath);

    const defaultAces = acl.length === 0 ? [
      { principal: 'BUILTIN\\Administrators', type: 'allow', permissions: ['FullControl'] },
      { principal: 'BUILTIN\\Users', type: 'allow', permissions: ['ReadAndExecute'] },
      { principal: 'NT AUTHORITY\\SYSTEM', type: 'allow', permissions: ['FullControl'] },
    ] : acl;

    const lines: string[] = [''];
    lines.push(`    Path   : Microsoft.PowerShell.Core\\FileSystem::${absPath}`);
    lines.push(`    Owner  : ${owner}`);
    lines.push(`    Group  : BUILTIN\\Administrators`);
    lines.push('');
    lines.push('FileSystemRights  AccessControlType IdentityReference       IsInherited InheritanceFlags PropagationFlags');
    lines.push('----------------  ----------------- -----------------       ----------- ---------------- ----------------');
    for (const ace of defaultAces) {
      const rights = ace.permissions.join(', ');
      const type = ace.type === 'allow' ? 'Allow' : 'Deny';
      const AccessControlType = type;
      lines.push(`${rights.padEnd(18)}${AccessControlType.padEnd(18)}${ace.principal.padEnd(24)}False       ContainerInherit None`);
    }
    return lines.join('\n');
  }

export function handleSetAcl(ctx: PSAclContext, args: string[]): string {
    const fs = ctx.device.getFileSystem();
    let path = '';
    let aclVarName = '';
    for (let i = 0; i < args.length; i++) {
      const a = args[i].toLowerCase();
      if (a === '-path' && args[i + 1]) { path = args[++i].replace(/^["']|["']$/g, ''); }
      else if (a === '-aclobject' && args[i + 1]) { aclVarName = args[++i].replace(/^\$/, '').toLowerCase(); }
      else if (!args[i].startsWith('-') && !path) { path = args[i].replace(/^["']|["']$/g, ''); }
      else if (!args[i].startsWith('-') && !aclVarName) {
        aclVarName = args[i].replace(/^["'\$]|["']$/g, '').toLowerCase();
      }
    }
    if (!path || !aclVarName) return '';
    const aclObj = ctx.sessionObjects.get(aclVarName);
    if (!aclObj || aclObj.kind !== 'acl') return '';

    const absPath = fs.normalizePath(path, ctx.cwd);
    if (!fs.exists(absPath)) return '';

    if (aclObj.protected) {
      // Replace entire ACL with the new rules
      const entry = (fs as any).resolve(absPath);
      if (entry) {
        entry.acl = aclObj.rules.map(r => ({
          principal: r.principal,
          type: r.ruleType.toLowerCase() as 'allow' | 'deny',
          permissions: [r.permission],
          protected: true,
        }));
        // Mark as protected so Get-Content can check it
        entry.aclProtected = true;
      }
    } else {
      // Merge rules into existing ACL
      for (const rule of aclObj.rules) {
        fs.addACE(absPath, {
          principal: rule.principal,
          type: rule.ruleType.toLowerCase() as 'allow' | 'deny',
          permissions: [rule.permission],
        });
      }
    }

    const lastRule = aclObj.rules[aclObj.rules.length - 1];
    ctx.device.getBus().publish({
      topic: 'windows.filesystem.acl-changed',
      payload: {
        deviceId: ctx.device.id,
        path: absPath,
        identity: lastRule?.principal ?? '',
        permissions: lastRule?.permission ?? '',
        changedBy: ctx.device.getUserManager().currentUser,
      },
    });
    return '';
  }
