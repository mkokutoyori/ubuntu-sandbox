/**
 * ScriptRunner — Execute bash scripts with privilege enforcement.
 *
 * Integrates the bash interpreter pipeline (lexer → parser → interpreter)
 * with the Linux simulation layer (VirtualFileSystem, LinuxUserManager).
 *
 * Checks:
 * - File existence
 * - Execute permission (owner/group/other bits)
 * - Shebang detection (#!/bin/bash, #!/bin/sh)
 */

import type { ShellContext } from '@/network/devices/linux/LinuxFileCommands';
import type { INode } from '@/network/devices/linux/VirtualFileSystem';
import { BashLexer } from '@/bash/lexer/BashLexer';
import { BashParser } from '@/bash/parser/BashParser';
import { BashInterpreter, type IOContext } from '@/bash/interpreter/BashInterpreter';

export interface ScriptResult {
  output: string;
  exitCode: number;
  /** Final environment variables after execution (for state sync). */
  env?: Record<string, string>;
}

/**
 * Execute a bash script from a file path.
 */
export function runScript(
  ctx: ShellContext,
  scriptPath: string,
  scriptArgs: string[],
  executeCommand: (args: string[]) => { output: string; exitCode: number },
): ScriptResult {
  const absPath = ctx.vfs.normalizePath(scriptPath, ctx.cwd);

  // 1. Check file existence
  const inode = ctx.vfs.resolveInode(absPath);
  if (!inode) {
    return { output: `bash: ${scriptPath}: No such file or directory\n`, exitCode: 127 };
  }

  if (inode.type === 'directory') {
    return { output: `bash: ${scriptPath}: Is a directory\n`, exitCode: 126 };
  }

  // 2. Check execute permission
  if (!checkExecutePermission(inode, ctx.uid, ctx.gid, ctx.userMgr)) {
    return { output: `bash: ${scriptPath}: Permission denied\n`, exitCode: 126 };
  }

  // 3. Read file content
  const content = ctx.vfs.readFile(absPath);
  if (content === null) {
    return { output: `bash: ${scriptPath}: No such file or directory\n`, exitCode: 127 };
  }

  // 4. Execute
  const io = buildIOContext(ctx);
  return runScriptContent(content, scriptPath, scriptArgs, executeCommand, buildEnvVars(ctx), io);
}

/**
 * Execute bash script content directly (for `bash -c "..."` or piped input).
 * No permission check — content is already in memory.
 */
export function runScriptContent(
  content: string,
  scriptName: string,
  scriptArgs: string[],
  executeCommand: (args: string[]) => { output: string; exitCode: number },
  variables?: Record<string, string>,
  io?: IOContext,
): ScriptResult {
  // Strip shebang, then preprocess heredocs
  const source = preprocessHeredocs(stripShebang(content));

  try {
    const lexer = new BashLexer();
    const parser = new BashParser();

    const tokens = lexer.tokenize(source);
    const ast = parser.parse(tokens);

    const interp = new BashInterpreter({
      executeCommand: (args) => executeCommand(args),
      variables: variables ?? {},
      scriptName,
      positionalArgs: scriptArgs,
      io,
    });

    const result = interp.execute(ast);
    // Export final environment for state synchronization
    const finalEnv: Record<string, string> = {};
    for (const [k, v] of interp.env.getAll()) {
      finalEnv[k] = v;
    }
    return { ...result, env: finalEnv };
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    // Normalize lexer/parser errors to "syntax error" format for compatibility
    const normalized = msg.replace(/Lexer error|Parse error/, 'syntax error');
    return { output: `bash: ${scriptName}: ${normalized}\n`, exitCode: 2 };
  }
}

// ─── Permission Checking ────────────────────────────────────────

/**
 * Check if the given uid/gid has execute permission on a file.
 */
function checkExecutePermission(
  inode: INode,
  uid: number,
  gid: number,
  userMgr: ShellContext['userMgr'],
): boolean {
  // Root can execute if any execute bit is set
  if (uid === 0) {
    return (inode.permissions & 0o111) !== 0;
  }

  const perms = inode.permissions & 0o7777;

  // Owner
  if (inode.uid === uid) {
    return !!((perms >> 6) & 1);
  }

  // Group
  const userGroups = userMgr.getUserGroups(userMgr.currentUser);
  const isInGroup = inode.gid === gid || userGroups.some(g => g.gid === inode.gid);
  if (isInGroup) {
    return !!((perms >> 3) & 1);
  }

  // Other
  return !!(perms & 1);
}

// ─── Helpers ────────────────────────────────────────────────────

/**
 * Preprocess heredocs in bash source.
 *
 * Transforms:
 *   cmd << 'DELIM'        →  cmd <<< 'body line 1\nbody line 2'
 *   cmd << DELIM           →  cmd <<< "body line 1\nbody line 2"
 *   cmd <<- DELIM          →  cmd <<< "body (tabs stripped)"
 *
 * Quoted delimiter  → single-quoted herestring (no expansion).
 * Unquoted delimiter → double-quoted herestring (expansion happens).
 */
function preprocessHeredocs(source: string): string {
  const lines = source.split('\n');
  const result: string[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];
    // Match << or <<- followed by optional space and a delimiter word
    // Use (?<!<) lookbehind and (?!<) lookahead to avoid matching <<< (herestring)
    const heredocMatch = line.match(
      /(?<!<)<<(-?)(?!<)\s*(?:'([^']+)'|"([^"]+)"|(\S+))\s*$/,
    );

    if (!heredocMatch) {
      result.push(line);
      i++;
      continue;
    }

    const stripTabs = heredocMatch[1] === '-';
    // Delimiter: group 2 = single-quoted, group 3 = double-quoted, group 4 = unquoted
    const delimiter = heredocMatch[2] ?? heredocMatch[3] ?? heredocMatch[4];
    const isQuoted = !!(heredocMatch[2] || heredocMatch[3]);

    // Collect body lines until we hit the delimiter
    const bodyLines: string[] = [];
    i++;
    while (i < lines.length) {
      const bodyLine = stripTabs ? lines[i].replace(/^\t+/, '') : lines[i];
      if (bodyLine.trim() === delimiter) {
        i++;
        break;
      }
      bodyLines.push(bodyLine);
      i++;
    }

    const body = bodyLines.join('\n');

    // Replace << ... with <<< 'body' or <<< "body"
    const prefix = line.substring(0, heredocMatch.index!);
    if (isQuoted) {
      // Single-quoted herestring: no expansion
      const escaped = body.replace(/\\/g, '\\\\').replace(/'/g, "'\\''");
      result.push(prefix + "<<< '" + escaped + "'");
    } else {
      // Double-quoted herestring: expansion will happen
      const escaped = body.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
      result.push(prefix + '<<< "' + escaped + '"');
    }
  }

  return result.join('\n');
}

/** Remove shebang line if present. */
function stripShebang(content: string): string {
  if (content.startsWith('#!')) {
    const newline = content.indexOf('\n');
    return newline >= 0 ? content.substring(newline + 1) : '';
  }
  return content;
}

/** Build an IO context for redirections from a ShellContext. */
function buildIOContext(ctx: ShellContext): IOContext {
  return {
    writeFile(path: string, content: string, append: boolean) {
      ctx.vfs.writeFile(path, content, ctx.uid, ctx.gid, ctx.umask, append);
    },
    readFile(path: string) {
      return ctx.vfs.readFile(path);
    },
    resolvePath(path: string) {
      return ctx.vfs.normalizePath(path, ctx.cwd);
    },
    stat(path: string) {
      const absPath = ctx.vfs.normalizePath(path, ctx.cwd);
      const inode = ctx.vfs.resolveInode(absPath);
      if (!inode) return null;
      return { type: inode.type === 'directory' ? 'directory' as const : 'file' as const };
    },
  };
}

/** Build initial environment variables from ShellContext. */
function buildEnvVars(ctx: ShellContext): Record<string, string> {
  return {
    HOME: ctx.uid === 0 ? '/root' : `/home/${ctx.userMgr.currentUser}`,
    PWD: ctx.cwd,
    USER: ctx.userMgr.currentUser,
    LOGNAME: ctx.userMgr.currentUser,
    UID: String(ctx.uid),
    SHELL: '/bin/bash',
    PATH: '/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin',
  };
}
