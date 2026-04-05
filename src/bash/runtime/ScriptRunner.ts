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
}

/**
 * Execute a bash script from a file path.
 */
export function runScript(
  ctx: ShellContext,
  scriptPath: string,
  scriptArgs: string[],
  executeCommand: (args: string[]) => string,
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
  executeCommand: (args: string[]) => string,
  variables?: Record<string, string>,
  io?: IOContext,
): ScriptResult {
  // Strip shebang
  const source = stripShebang(content);

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

    return interp.execute(ast);
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return { output: `bash: ${scriptName}: ${msg}\n`, exitCode: 2 };
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
