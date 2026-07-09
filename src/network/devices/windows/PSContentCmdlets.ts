import { parsePSArgs } from './psArgs';
import type { PSDeviceContext } from './PowerShellExecutor';

export interface PSContentContext {
  device: PSDeviceContext;
  cwd: string;
  errorList: string[];
  tryParseArrayLiteral: (expr: string) => string[] | null;
  unquoteAndExpand: (raw: string) => string;
}

export function handleGetContent(ctx: PSContentContext, args: string[]): string {
    const fs = ctx.device.getFileSystem();
    let path = '';
    let tail: number | undefined, totalCount: number | undefined, readCount: number | undefined;
    let raw = false, asByteStream = false, stream = '', wait = false;
    for (let i = 0; i < args.length; i++) {
      const a = args[i].toLowerCase();
      if ((a === '-path' || a === '-literalpath') && args[i + 1]) { path = args[++i].replace(/^["']|["']$/g, ''); }
      else if ((a === '-tail' || a === '-last') && args[i + 1]) { tail = parseInt(args[++i], 10); }
      else if ((a === '-totalcount' || a === '-head' || a === '-first') && args[i + 1]) { totalCount = parseInt(args[++i], 10); }
      else if (a === '-readcount' && args[i + 1]) { readCount = parseInt(args[++i], 10); }
      else if (a === '-raw') { raw = true; }
      else if (a === '-asbytestream') { asByteStream = true; }
      else if (a === '-stream' && args[i + 1]) { stream = args[++i].replace(/^["']|["']$/g, ''); i++; } // skip stream name
      else if (a === '-wait') { wait = true; }
      else if (!args[i].startsWith('-') && !path) { path = args[i].replace(/^["']|["']$/g, ''); }
    }
    if (!path) return '';
    const absPath = fs.normalizePath(path, ctx.cwd);

    // -Stream: alternate data streams not natively supported
    if (stream) {
      return `Get-Content : The -Stream parameter is not supported in this simulator.\nAt line:1 char:1\n    + CategoryInfo          : NotImplemented\n    + FullyQualifiedErrorId : NotImplemented,Microsoft.PowerShell.Commands.GetContentCommand`;
    }

    // -Wait: tail-follow not supported in simulator
    if (wait) {
      return `Get-Content : The -Wait parameter is not supported in this simulator.\nAt line:1 char:1\n    + CategoryInfo          : NotImplemented`;
    }

    // ACL enforcement: protected files require explicit Allow ACE covering the current user
    if (fs.isAclProtected(absPath)) {
      const mgr = ctx.device.getUserManager();
      if (!mgr.isCurrentUserAdmin()) {
        const acl = fs.getACL(absPath);
        const user = mgr.currentUser.toLowerCase();
        const isAdmin = mgr.isCurrentUserAdmin();
        const hasAllow = acl.some(ace => {
          if (ace.type !== 'allow') return false;
          const p = ace.principal.toLowerCase();
          if (p === 'everyone') return true;
          if (p === user || p.endsWith('\\' + user)) return true;
          if ((p === 'administrators' || p === 'builtin\\administrators') && isAdmin) return true;
          if ((p === 'users' || p === 'builtin\\users') && !isAdmin) return true;
          return false;
        });
        if (!hasAllow) {
          const errMsg = `Get-Content : Access to the path '${absPath}' is denied.`;
          ctx.errorList.unshift(errMsg);
          return errMsg;
        }
      }
    }

    const r = fs.readFile(absPath);
    if (!r.ok) return `Get-Content : Cannot find path '${path}' because it does not exist.`;
    const content = r.content ?? '';

    if (asByteStream) {
      // Return byte values as space-separated numbers
      const bytes = Array.from(content).map(c => c.charCodeAt(0));
      return bytes.join('\n');
    }

    if (raw) {
      // Return whole file as single string (no line splitting)
      return content;
    }

    if (!content) return '';
    const lines = content.split(/\r?\n/);
    if (tail !== undefined) return lines.slice(-tail).join('\n');
    if (totalCount !== undefined) return lines.slice(0, totalCount).join('\n');
    if (readCount === 0) return content; // -ReadCount 0: return as one string
    return content;
  }

export function handleSetContent(ctx: PSContentContext, args: string[]): string {
    const fs = ctx.device.getFileSystem();
    let path = '', value = '';
    let noNewline = false;
    const positionals: string[] = [];
    for (let i = 0; i < args.length; i++) {
      const a = args[i].toLowerCase();
      if (a === '-path' && args[i + 1]) { path = args[++i].replace(/^["']|["']$/g, ''); }
      else if (a === '-nonewline') { noNewline = true; }
      else if (a === '-value' && args[i + 1]) {
        const raw = args[++i];
        const items = ctx.tryParseArrayLiteral(raw);
        if (items) {
          // Items in the array literal still need backtick expansion.
          const expanded = items.map((it) => ctx.unquoteAndExpand(it));
          value = expanded.join(noNewline ? '' : '\n');
        } else {
          value = ctx.unquoteAndExpand(raw);
        }
      }
      else if (!args[i].startsWith('-')) {
        const raw = args[i];
        const items = ctx.tryParseArrayLiteral(raw);
        if (items) { positionals.push(...items.map((it) => ctx.unquoteAndExpand(it))); }
        else { positionals.push(ctx.unquoteAndExpand(raw)); }
      }
    }
    // Positional: first is path, rest are values joined by newlines or empty string
    if (!path && positionals.length > 0) path = positionals[0];
    if (!value && positionals.length > 1) value = positionals.slice(1).join(noNewline ? '' : '\n');
    if (!path) return '';
    const absPath = fs.normalizePath(path, ctx.cwd);
    fs.createFile(absPath, value);
    return '';
  }

export function handleSetContentWithPiped(ctx: PSContentContext, args: string[], content: string): string {
    const fs = ctx.device.getFileSystem();
    let path = '';
    for (let i = 0; i < args.length; i++) {
      const a = args[i].toLowerCase();
      if (a === '-path' && args[i + 1]) { path = args[++i].replace(/^["']|["']$/g, ''); }
      else if (!args[i].startsWith('-') && !path) { path = args[i].replace(/^["']|["']$/g, ''); }
    }
    if (!path) return '';
    const absPath = fs.normalizePath(path, ctx.cwd);
    fs.createFile(absPath, content);
    return '';
  }

export async function handleAddContent(ctx: PSContentContext, args: string[]): Promise<string> {
    let filePath = '', value = '';
    for (let i = 0; i < args.length; i++) {
      if (args[i] === '-Path' && args[i + 1]) { filePath = args[++i]; }
      else if (args[i] === '-Value' && args[i + 1]) { value = args[++i].replace(/^["']|["']$/g, ''); }
      else if (!args[i].startsWith('-') && !filePath) { filePath = args[i]; }
    }
    if (!filePath) return "Add-Content : Cannot bind argument to parameter 'Path' because it is an empty string.";
    if (value) {
      return await ctx.device.executeCmdCommand(`echo ${value} >> ${filePath}`);
    }
    return '';
  }

export async function handleClearContent(ctx: PSContentContext, args: string[]): Promise<string> {
    let filePath = '';
    for (let i = 0; i < args.length; i++) {
      if (args[i] === '-Path' && args[i + 1]) { filePath = args[++i]; }
      else if (!args[i].startsWith('-') && !filePath) { filePath = args[i]; }
    }
    if (!filePath) return "Clear-Content : Cannot bind argument to parameter 'Path' because it is an empty string.";
    const fs = ctx.device.getFileSystem();
    const absPath = fs.normalizePath(filePath, ctx.cwd);
    if (!fs.exists(absPath)) return `Clear-Content : Cannot find path '${filePath}' because it does not exist.`;
    fs.createFile(absPath, '');
    return '';
  }

export async function handleOutFile(ctx: PSContentContext, args: string[]): Promise<string> {
    let filePath = '';
    for (let i = 0; i < args.length; i++) {
      if (args[i] === '-FilePath' && args[i + 1]) { filePath = args[++i]; }
      else if (!args[i].startsWith('-') && !filePath) { filePath = args[i]; }
    }
    if (!filePath) return "Out-File : Cannot bind argument to parameter 'FilePath' because it is an empty string.";
    // Out-File with no pipeline input creates empty file
    return await ctx.device.executeCmdCommand(`echo. > ${filePath}`);
  }
