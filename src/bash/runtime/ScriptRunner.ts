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
import { DaemonParkSignal } from '@/bash/errors/BashError';
import type { AliasTable } from '@/bash/runtime/AliasTable';

export interface ScriptResult {
  output: string;
  exitCode: number;
  /** Final environment variables after execution (for state sync). */
  env?: Record<string, string>;
  /**
   * Pure stderr stream (content routed to fd 2). `output` remains the
   * merged terminal view; this lets callers route stderr independently.
   */
  stderr?: string;
  /** True when a `daemonMode` job parked in an unconditional loop instead
   *  of running forever — see {@link DaemonParkSignal}. `interp` is the
   *  live interpreter, kept alive so `kill -SIGNAL` can fire its traps. */
  parked?: boolean;
  interp?: BashInterpreter;
}

/**
 * Execute a bash script from a file path.
 */
export function runScript(
  ctx: ShellContext,
  scriptPath: string,
  scriptArgs: string[],
  executeCommand: (args: string[], env?: Record<string, string>, background?: boolean) => { output: string; exitCode: number; backgroundPid?: number },
  aliases?: AliasTable,
  functions?: Map<string, import('@/bash/parser/ASTNode').Command>,
  invocation: 'direct' | 'interpreter' = 'direct',
  identity?: { pid?: number; ppid?: number; initialExitCode?: number },
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

  // 2. Direct invocation (./script) needs the execute bit; running the
  //    file through an interpreter (`bash script`) only needs to read it.
  const permitted = invocation === 'interpreter'
    ? checkReadPermission(inode, ctx.uid, ctx.gid, ctx.userMgr)
    : checkExecutePermission(inode, ctx.uid, ctx.gid, ctx.userMgr);
  if (!permitted) {
    return { output: `bash: ${scriptPath}: Permission denied\n`, exitCode: 126 };
  }

  // 3. Read file content
  const content = ctx.vfs.readFile(absPath);
  if (content === null) {
    return { output: `bash: ${scriptPath}: No such file or directory\n`, exitCode: 127 };
  }

  // 4. Execute
  const io = buildIOContext(ctx);
  return runScriptContent(
    content, scriptPath, scriptArgs, executeCommand,
    buildEnvVars(ctx), io, identity, aliases, functions,
  );
}

/**
 * Execute bash script content directly (for `bash -c "..."` or piped input).
 * No permission check — content is already in memory.
 */
export function runScriptContent(
  content: string,
  scriptName: string,
  scriptArgs: string[],
  executeCommand: (args: string[], env?: Record<string, string>, background?: boolean) => { output: string; exitCode: number; backgroundPid?: number },
  variables?: Record<string, string>,
  io?: IOContext,
  identity?: { pid?: number; ppid?: number; initialExitCode?: number; daemonMode?: boolean },
  aliases?: AliasTable,
  functions?: Map<string, import('@/bash/parser/ASTNode').Command>,
): ScriptResult {
  // Strip shebang, then preprocess heredocs
  const source = preprocessHeredocs(stripShebang(content));

  let interp: BashInterpreter | undefined;
  try {
    const lexer = new BashLexer();
    const parser = new BashParser();

    const tokens = lexer.tokenize(source);
    const ast = parser.parse(tokens);

    interp = new BashInterpreter({
      executeCommand: (args, env, background) => executeCommand(args, env, background),
      variables: variables ?? {},
      scriptName,
      positionalArgs: scriptArgs,
      io,
      pid: identity?.pid,
      ppid: identity?.ppid,
      initialExitCode: identity?.initialExitCode,
      aliases,
      functions,
      daemonMode: identity?.daemonMode,
    });

    const result = interp.execute(ast);
    // Export final environment for state synchronization
    const finalEnv: Record<string, string> = {};
    for (const [k, v] of interp.env.getAll()) {
      finalEnv[k] = v;
    }
    return { ...result, env: finalEnv };
  } catch (e: unknown) {
    if (e instanceof DaemonParkSignal) {
      const parkedInterp = (e.interp as BashInterpreter | undefined) ?? interp;
      const finalEnv: Record<string, string> = {};
      if (parkedInterp) for (const [k, v] of parkedInterp.env.getAll()) finalEnv[k] = v;
      return { output: e.output, exitCode: 0, env: finalEnv, parked: true, interp: parkedInterp };
    }
    const msg = e instanceof Error ? e.message : String(e);
    // Normalize lexer/parser errors to "syntax error" format for compatibility
    const normalized = msg.replace(/Lexer error|Parse error/, 'syntax error');
    return { output: `bash: ${scriptName}: ${normalized}\n`, exitCode: 2 };
  }
}

/**
 * Async twin of {@link runScriptContent}: drives the same interpreter core
 * through its async driver so external commands may return Promises
 * (network commands that traverse the simulated wire).
 */
export async function runScriptContentAsync(
  content: string,
  scriptName: string,
  scriptArgs: string[],
  executeCommand: (args: string[], env?: Record<string, string>, background?: boolean) =>
    { output: string; exitCode: number; stderr?: string; backgroundPid?: number }
    | Promise<{ output: string; exitCode: number; stderr?: string; backgroundPid?: number }>,
  variables?: Record<string, string>,
  io?: IOContext,
  identity?: { pid?: number; ppid?: number; initialExitCode?: number; daemonMode?: boolean },
  aliases?: AliasTable,
  functions?: Map<string, import('@/bash/parser/ASTNode').Command>,
): Promise<ScriptResult> {
  const source = preprocessHeredocs(stripShebang(content));

  let interp: BashInterpreter | undefined;
  try {
    const lexer = new BashLexer();
    const parser = new BashParser();

    const tokens = lexer.tokenize(source);
    const ast = parser.parse(tokens);

    interp = new BashInterpreter({
      executeCommand: (args, env, background) => executeCommand(args, env, background),
      variables: variables ?? {},
      scriptName,
      positionalArgs: scriptArgs,
      io,
      pid: identity?.pid,
      ppid: identity?.ppid,
      initialExitCode: identity?.initialExitCode,
      aliases,
      functions,
      daemonMode: identity?.daemonMode,
    });

    const result = await interp.executeAsync(ast);
    const finalEnv: Record<string, string> = {};
    for (const [k, v] of interp.env.getAll()) {
      finalEnv[k] = v;
    }
    return { ...result, env: finalEnv };
  } catch (e: unknown) {
    if (e instanceof DaemonParkSignal) {
      const parkedInterp = (e.interp as BashInterpreter | undefined) ?? interp;
      const finalEnv: Record<string, string> = {};
      if (parkedInterp) for (const [k, v] of parkedInterp.env.getAll()) finalEnv[k] = v;
      return { output: e.output, exitCode: 0, env: finalEnv, parked: true, interp: parkedInterp };
    }
    const msg = e instanceof Error ? e.message : String(e);
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

function checkReadPermission(
  inode: INode,
  uid: number,
  gid: number,
  userMgr: ShellContext['userMgr'],
): boolean {
  if (uid === 0) return true;

  const perms = inode.permissions & 0o7777;

  if (inode.uid === uid) {
    return !!((perms >> 6) & 4);
  }

  const userGroups = userMgr.getUserGroups(userMgr.currentUser);
  const isInGroup = inode.gid === gid || userGroups.some(g => g.gid === inode.gid);
  if (isInGroup) {
    return !!((perms >> 3) & 4);
  }

  return !!(perms & 4);
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
    // Match << or <<- followed by optional space and a delimiter word.
    // Use (?<!<) lookbehind and (?!<) lookahead to avoid matching <<< (herestring).
    // No end-of-line anchor: `cat << 'EOF' > file` is common and valid —
    // whatever trails the delimiter (a redirection, another word) is kept
    // verbatim after the `<<<` replacement below.
    const heredocMatch = line.match(
      /(?<!<)<<(-?)(?!<)\s*(?:'([^']+)'|"([^"]+)"|(\S+))/,
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

    // Replace << ... with <<< 'body' or <<< "body", preserving whatever
    // trailed the delimiter on the original line (e.g. `> file`).
    const prefix = line.substring(0, heredocMatch.index!);
    const suffix = line.substring(heredocMatch.index! + heredocMatch[0].length);
    if (isQuoted) {
      // Single-quoted herestring: no expansion, and no escape processing
      // either — a literal backslash in the body must stay a single
      // backslash, so only the quote character itself needs the
      // close-quote/escape/reopen-quote trick.
      const escaped = body.replace(/'/g, "'\\''");
      result.push(prefix + "<<< '" + escaped + "'" + suffix);
    } else {
      // Double-quoted herestring: expansion will happen. An unquoted
      // heredoc's own escaping rules (\$, \`, \\ are special; any other
      // backslash is literal) already match double-quote expansion rules
      // exactly, so backslashes pass through untouched — only the quote
      // character itself needs escaping so it doesn't end the herestring
      // early when re-lexed.
      const escaped = body.replace(/"/g, '\\"');
      result.push(prefix + '<<< "' + escaped + '"' + suffix);
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
    globExpand(pattern: string, cwd: string) {
      const hits = ctx.vfs.globExpand(pattern, cwd);
      if (hits.length === 0) return null;
      if (!pattern.startsWith('/')) {
        const prefix = cwd === '/' ? '/' : cwd + '/';
        return hits.map(h => h.startsWith(prefix) ? h.slice(prefix.length) : h);
      }
      return hits;
    },
    homeFor(user: string) {
      const u = ctx.userMgr.getUser(user);
      return u ? u.home : null;
    },
  };
}

/** Build initial environment variables from ShellContext. */
function buildEnvVars(ctx: ShellContext): Record<string, string> {
  if (ctx.envOverride) return { ...ctx.envOverride };
  return {
    HOME: ctx.uid === 0 ? '/root' : `/home/${ctx.userMgr.currentUser}`,
    PWD: ctx.cwd,
    USER: ctx.userMgr.currentUser,
    LOGNAME: ctx.userMgr.currentUser,
    UID: String(ctx.uid),
    EUID: String(ctx.uid),
    SHELL: '/bin/bash',
    PATH: '/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin',
  };
}
