/**
 * Linux command executor - orchestrates parsing and dispatching to command modules.
 */

import { VirtualFileSystem } from './VirtualFileSystem';
import { LinuxUserManager } from './LinuxUserManager';
import { LinuxCronManager } from './LinuxCronManager';
import { splitChains, type CommandChain, type ParsedCommand } from './LinuxShellParser';
import { type ShellContext, cmdTouch, cmdLs, cmdCat, cmdEcho, cmdCp, cmdMv, cmdRm, cmdMkdir, cmdRmdir, cmdLn, cmdPwd, cmdTee, expandGlob } from './LinuxFileCommands';
import { cmdGrep, cmdHead, cmdTail, cmdWc, cmdSort, cmdCut, cmdUniq, cmdTr, cmdAwk } from './LinuxTextCommands';
import { cmdFind, cmdLocate, cmdWhich, cmdWhereis, cmdCommand, cmdUpdatedb } from './LinuxSearchCommands';
import { cmdChmod, cmdChown, cmdChgrp, cmdStat, cmdUmask, cmdTest, cmdMkfifo } from './LinuxPermCommands';
import { cmdUseradd, cmdUsermod, cmdUserdel, cmdPasswd, cmdChpasswd, cmdChage, cmdGroupadd, cmdGroupmod, cmdGroupdel, cmdGpasswd, cmdId, cmdWhoami, cmdGroups, cmdWho, cmdW, cmdLast, cmdGetent, cmdSudoCheck } from './LinuxUserCommands';
import { executeScript, executeScriptContent } from './LinuxScriptExecutor';
import { executeIpCommand, type IpNetworkContext } from './LinuxIpCommand';

export class LinuxCommandExecutor {
  readonly vfs: VirtualFileSystem;
  readonly userMgr: LinuxUserManager;
  readonly cron: LinuxCronManager;
  private ipNetworkCtx: IpNetworkContext | null = null;
  private cwd = '/root';
  private umask = 0o022;
  private isServer: boolean;
  private env: Map<string, string> = new Map();
  // Stack for su sessions: stores previous user context
  private suStack: Array<{ user: string; uid: number; gid: number; cwd: string; umask: number }> = [];

  constructor(isServer = false) {
    this.vfs = new VirtualFileSystem();
    this.userMgr = new LinuxUserManager(this.vfs);
    this.cron = new LinuxCronManager();
    this.isServer = isServer;

    // Default environment
    this.env.set('PATH', '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:/usr/games:/usr/local/games');

    if (!isServer) {
      // Regular PC: default user is 'user' (non-root)
      const uid = 1000;
      const gid = 1000;
      this.userMgr.useradd('user', { m: true, s: '/bin/bash' });
      // Add default groups for regular user (like Ubuntu)
      this.userMgr.usermod('user', { aG: 'sudo,adm' });
      // Set default password 'admin'
      this.userMgr.setPassword('user', 'admin');
      // Create skeleton files
      this.createSkeletonFiles('/home/user', uid, gid);
      this.userMgr.currentUser = 'user';
      this.userMgr.currentUid = uid;
      this.userMgr.currentGid = gid;
      this.cwd = '/home/user';
    }
  }

  /** Set the network context for ip command support */
  setIpNetworkContext(ctx: IpNetworkContext): void {
    this.ipNetworkCtx = ctx;
  }

  private ctx(): ShellContext {
    return {
      vfs: this.vfs,
      userMgr: this.userMgr,
      cwd: this.cwd,
      umask: this.umask,
      uid: this.userMgr.currentUid,
      gid: this.userMgr.currentGid,
    };
  }

  /**
   * Execute a command string, handling chains (&&, ||, ;), pipes, and redirections.
   */
  execute(input: string): string {
    const trimmed = input.trim();
    if (!trimmed) return '';

    const chains = splitChains(trimmed);
    const allOutputs: string[] = [];
    let lastExitCode = 0;

    for (let ci = 0; ci < chains.length; ci++) {
      const chain = chains[ci];

      // Check chain operator from previous chain
      if (ci > 0) {
        const prevOp = chains[ci - 1].operator;
        if (prevOp === '&&' && lastExitCode !== 0) continue;
        if (prevOp === '||' && lastExitCode === 0) continue;
      }

      const result = this.executePipeline(chain);
      lastExitCode = result.exitCode;
      if (result.output) allOutputs.push(result.output);
    }

    return allOutputs.join('\n');
  }

  private executePipeline(chain: CommandChain): { output: string; exitCode: number } {
    let pipeInput: string | undefined;
    let lastOutput = '';
    let exitCode = 0;
    const isPipe = chain.pipeline.length > 1;

    for (let i = 0; i < chain.pipeline.length; i++) {
      const segment = chain.pipeline[i];
      const cmd = segment.commands[0];
      const result = this.executeSingleCommand(cmd, pipeInput);
      lastOutput = result.output;
      exitCode = result.exitCode;
      // Strip ANSI codes when piping to next command (like real terminal isatty check)
      if (isPipe && i < chain.pipeline.length - 1) {
        // eslint-disable-next-line no-control-regex
        pipeInput = lastOutput.replace(/\x1b\[[0-9;]*m/g, '');
      } else {
        pipeInput = lastOutput;
      }
    }

    return { output: lastOutput, exitCode };
  }

  private executeSingleCommand(parsed: ParsedCommand, pipeInput?: string): { output: string; exitCode: number } {
    const { args, redirections, stdinRedirect, mergeStderr } = parsed;
    if (args.length === 0) return { output: '', exitCode: 0 };

    // Read stdin from file if redirected
    let stdin = pipeInput;
    if (stdinRedirect) {
      const absPath = this.vfs.normalizePath(stdinRedirect, this.cwd);
      const content = this.vfs.readFile(absPath);
      stdin = content ?? '';
    }

    // Strip sudo prefix
    let cmdArgs = [...args];
    let isSudo = false;
    let savedUser: { user: string; uid: number; gid: number; cwd: string } | null = null;
    if (cmdArgs[0] === 'sudo') {
      isSudo = true;
      cmdArgs = cmdArgs.slice(1);
      // Handle sudo -l (no arguments = current user)
      if (cmdArgs.length === 0 || cmdArgs[0] === '-l') {
        return this.dispatch('sudo', cmdArgs, stdin, true);
      }
      // Handle sudo -u user cmd
      if (cmdArgs[0] === '-u' && cmdArgs.length >= 3) {
        cmdArgs = cmdArgs.slice(2);
      }
      // Temporarily become root for the command
      savedUser = { user: this.userMgr.currentUser, uid: this.userMgr.currentUid, gid: this.userMgr.currentGid, cwd: this.cwd };
      this.userMgr.currentUser = 'root';
      this.userMgr.currentUid = 0;
      this.userMgr.currentGid = 0;
    }

    if (cmdArgs.length === 0) {
      if (savedUser) { this.userMgr.currentUser = savedUser.user; this.userMgr.currentUid = savedUser.uid; this.userMgr.currentGid = savedUser.gid; }
      return { output: '', exitCode: 0 };
    }

    const cmd = cmdArgs[0];
    const cmdArgsList = cmdArgs.slice(1);

    let output = '';
    let exitCode = 0;

    try {
      const result = this.dispatch(cmd, cmdArgsList, stdin, isSudo);
      output = result.output;
      exitCode = result.exitCode;
    } catch (e) {
      output = `${cmd}: error`;
      exitCode = 1;
    }

    // Restore user after sudo — BUT NOT if the command was `su` (su manages its own context)
    if (savedUser && cmd !== 'su') {
      this.userMgr.currentUser = savedUser.user;
      this.userMgr.currentUid = savedUser.uid;
      this.userMgr.currentGid = savedUser.gid;
    }
    // For sudo su: fix the suStack to return to the original (pre-sudo) user, not root
    if (savedUser && cmd === 'su' && this.suStack.length > 0) {
      const top = this.suStack[this.suStack.length - 1];
      top.user = savedUser.user;
      top.uid = savedUser.uid;
      top.gid = savedUser.gid;
      top.cwd = savedUser.cwd;
    }

    // Handle stderr redirection
    if (exitCode !== 0 && redirections.some(r => r.type === '2>') && !mergeStderr) {
      const stderrRedir = redirections.find(r => r.type === '2>');
      if (stderrRedir && stderrRedir.target !== '/dev/null') {
        const absPath = this.vfs.normalizePath(stderrRedir.target, this.cwd);
        this.vfs.writeFile(absPath, output + '\n', this.ctx().uid, this.ctx().gid, this.umask);
      }
      // If stderr is redirected away and there's no stdout redir, output is suppressed for errors
      if (!mergeStderr) output = '';
    }

    // Handle stdout redirection
    for (const redir of redirections) {
      if (redir.type === '>' || redir.type === '>>') {
        const absPath = this.vfs.normalizePath(redir.target, this.cwd);
        const append = redir.type === '>>';
        // Don't add newline for binary content or empty output
        const isBinary = /[\x00-\x08\x0e-\x1f\x80-\xff]/.test(output);
        const needsNewline = output.length > 0 && !isBinary;
        const content = needsNewline ? output + '\n' : output;
        this.vfs.writeFile(absPath, content, this.ctx().uid, this.ctx().gid, this.umask, append);
        output = ''; // stdout was redirected, don't display
      }
    }

    return { output, exitCode };
  }

  private dispatch(cmd: string, args: string[], stdin?: string, isSudo = false): { output: string; exitCode: number } {
    const c = this.ctx();

    // Root-only commands — reject if not root
    const rootOnlyCmds = ['useradd', 'adduser', 'usermod', 'userdel', 'deluser',
      'groupadd', 'groupmod', 'groupdel', 'chpasswd', 'chage', 'chown', 'chgrp'];
    if (rootOnlyCmds.includes(cmd) && this.userMgr.currentUid !== 0) {
      return { output: `${cmd}: Permission denied`, exitCode: 1 };
    }
    // passwd: non-root can only change own password (no args)
    if (cmd === 'passwd' && this.userMgr.currentUid !== 0 && args.length > 0 && !args[0].startsWith('-')) {
      return { output: `passwd: You may not view or modify password information for ${args[0]}.`, exitCode: 1 };
    }

    switch (cmd) {
      // File commands
      case 'touch': return { output: cmdTouch(c, args), exitCode: 0 };
      case 'ls': {
        const out = cmdLs(c, args);
        const isErr = out.includes('cannot access');
        return { output: out, exitCode: isErr ? 2 : 0 };
      }
      case 'cat': {
        // Permission check: can user read this file?
        for (const arg of args) {
          if (arg.startsWith('-')) continue;
          const path = this.vfs.normalizePath(arg, this.cwd);
          const inode = this.vfs.resolveInode(path);
          if (inode && !this.checkPermission(inode, 'r')) {
            return { output: `cat: ${arg}: Permission denied`, exitCode: 1 };
          }
        }
        const out = cmdCat(c, args);
        const isError = out.includes('No such file');
        return { output: out, exitCode: isError ? 1 : 0 };
      }
      case 'echo': {
        // Expand env vars in args before echo
        const expanded = args.map(a => this.expandEnvVars(a));
        return { output: cmdEcho(c, expanded), exitCode: 0 };
      }
      case 'cp': return { output: cmdCp(c, args), exitCode: 0 };
      case 'mv': return { output: cmdMv(c, args), exitCode: 0 };
      case 'rm': return { output: cmdRm(c, args), exitCode: 0 };
      case 'mkdir': return { output: cmdMkdir(c, args), exitCode: 0 };
      case 'rmdir': return { output: cmdRmdir(c, args), exitCode: 0 };
      case 'ln': return { output: cmdLn(c, args), exitCode: 0 };
      case 'pwd': return { output: cmdPwd(c), exitCode: 0 };
      case 'tee': return { output: cmdTee(c, args, stdin ?? ''), exitCode: 0 };

      // cd changes state
      case 'cd': {
        let target = args[0];
        if (!target || target === '~') {
          // Default to current user's home dir
          const user = this.userMgr.getUser(this.userMgr.currentUser);
          target = user?.home || '/root';
        } else if (target.startsWith('~/')) {
          const user = this.userMgr.getUser(this.userMgr.currentUser);
          target = (user?.home || '/root') + target.slice(1);
        } else if (target === '-') {
          const user = this.userMgr.getUser(this.userMgr.currentUser);
          target = user?.home || '/root';
        }
        const newCwd = this.vfs.normalizePath(target, this.cwd);
        const inode = this.vfs.resolveInode(newCwd);
        if (!inode) {
          return { output: `bash: cd: ${args[0] || target}: No such file or directory`, exitCode: 1 };
        }
        if (inode.type !== 'directory') {
          return { output: `bash: cd: ${args[0] || target}: Not a directory`, exitCode: 1 };
        }
        // Check execute permission on directory
        if (!this.checkPermission(inode, 'x')) {
          return { output: `bash: cd: ${args[0] || target}: Permission denied`, exitCode: 1 };
        }
        this.cwd = newCwd;
        return { output: '', exitCode: 0 };
      }

      // Text commands
      case 'grep': return { output: cmdGrep(c, args, stdin), exitCode: 0 };
      case 'head': return { output: cmdHead(c, args, stdin), exitCode: 0 };
      case 'tail': return { output: cmdTail(c, args, stdin), exitCode: 0 };
      case 'wc': return { output: cmdWc(c, args, stdin), exitCode: 0 };
      case 'sort': return { output: cmdSort(c, args, stdin), exitCode: 0 };
      case 'cut': return { output: cmdCut(c, args, stdin), exitCode: 0 };
      case 'uniq': return { output: cmdUniq(c, args, stdin), exitCode: 0 };
      case 'tr': return { output: cmdTr(c, args, stdin), exitCode: 0 };
      case 'awk': return { output: cmdAwk(c, args, stdin), exitCode: 0 };

      // Search commands
      case 'find': return { output: cmdFind(c, args), exitCode: 0 };
      case 'locate': return { output: cmdLocate(c, args), exitCode: 0 };
      case 'which': return { output: cmdWhich(c, args), exitCode: 0 };
      case 'whereis': return { output: cmdWhereis(c, args), exitCode: 0 };
      case 'command': return { output: cmdCommand(c, args), exitCode: cmdCommand(c, args) ? 0 : 1 };
      case 'updatedb': return { output: cmdUpdatedb(c), exitCode: 0 };

      // Permission commands
      case 'chmod': return { output: cmdChmod(c, args), exitCode: 0 };
      case 'chown': return { output: cmdChown(c, args), exitCode: 0 };
      case 'chgrp': return { output: cmdChgrp(c, args), exitCode: 0 };
      case 'stat': return { output: cmdStat(c, args), exitCode: 0 };
      case 'umask': {
        const result = cmdUmask(c, args);
        if (result.newUmask !== undefined) this.umask = result.newUmask;
        return { output: result.output, exitCode: 0 };
      }
      case 'test':
      case '[': {
        // Handle [ ... ] syntax
        const testArgs = cmd === '[' ? args.filter(a => a !== ']') : args;
        const result = cmdTest(c, testArgs);
        return { output: '', exitCode: result.success ? 0 : 1 };
      }
      case 'mkfifo': return { output: cmdMkfifo(c, args), exitCode: 0 };

      // User commands
      case 'useradd': {
        const out = cmdUseradd(c, args);
        if (!out && args.includes('-m')) {
          // Create skeleton files in new home dir
          const username = args.filter(a => !a.startsWith('-')).find(a => !['bash', '/bin/bash', '/bin/sh', '/sbin/nologin', '/usr/sbin/nologin'].includes(a));
          if (username) {
            const user = this.userMgr.getUser(username);
            if (user) this.createSkeletonFiles(user.home, user.uid, user.gid);
          }
        }
        return { output: out, exitCode: out ? 1 : 0 };
      }
      case 'adduser': return this.handleAdduser(args);
      case 'usermod': return { output: cmdUsermod(c, args), exitCode: 0 };
      case 'userdel': return this.handleUserdel(args);
      case 'deluser': return this.handleDeluser(args);
      case 'passwd': return this.handlePasswd(args);
      case 'chpasswd': return { output: cmdChpasswd(c, stdin ?? ''), exitCode: 0 };
      case 'chage': return { output: cmdChage(c, args), exitCode: 0 };
      case 'groupadd': return { output: cmdGroupadd(c, args), exitCode: 0 };
      case 'groupmod': return { output: cmdGroupmod(c, args), exitCode: 0 };
      case 'groupdel': return { output: cmdGroupdel(c, args), exitCode: 0 };
      case 'gpasswd': return this.handleGpasswd(args);
      case 'id': {
        const out = cmdId(c, args);
        return { output: out, exitCode: out.includes('no such user') ? 1 : 0 };
      }
      case 'whoami': return { output: cmdWhoami(c), exitCode: 0 };
      case 'groups': return { output: cmdGroups(c, args), exitCode: 0 };
      case 'who': return { output: cmdWho(c), exitCode: 0 };
      case 'w': return { output: cmdW(c), exitCode: 0 };
      case 'last': return { output: cmdLast(c, args), exitCode: 0 };
      case 'getent': return { output: cmdGetent(c, args), exitCode: 0 };
      case 'sudo': return this.handleSudoCmd(args);

      // su - switch user
      case 'su': return this.handleSu(args);

      // source / . — execute file in current shell context
      case 'source':
      case '.': {
        if (args.length === 0) return { output: 'bash: source: filename argument required', exitCode: 2 };
        // In simulator, source is a no-op but we silently succeed
        return { output: '', exitCode: 0 };
      }

      // export — set environment variable
      case 'export': {
        for (const arg of args) {
          const eqIdx = arg.indexOf('=');
          if (eqIdx > 0) {
            const key = arg.slice(0, eqIdx);
            const val = this.expandEnvVars(arg.slice(eqIdx + 1));
            this.env.set(key, val);
          }
        }
        return { output: '', exitCode: 0 };
      }

      // env — print environment
      case 'env': {
        const lines: string[] = [];
        for (const [k, v] of this.env) { lines.push(`${k}=${v}`); }
        return { output: lines.join('\n'), exitCode: 0 };
      }

      // Crontab
      case 'crontab': return this.handleCrontab(args, stdin);

      // Script execution
      case 'bash':
      case 'sh': {
        if (args.length > 0) {
          const result = executeScript(c, args[0], args.slice(1), (cmd) => this.execute(cmd));
          return { output: result.output, exitCode: result.exitCode };
        }
        return { output: '', exitCode: 0 };
      }

      // Hostname
      case 'hostname':
        return { output: args[0] || 'localhost', exitCode: 0 };

      // clear - send ANSI escape to clear terminal
      case 'clear': return { output: '\x1b[2J\x1b[H', exitCode: 0 };
      case 'reset': return { output: '\x1b[2J\x1b[H', exitCode: 0 };

      // Sleep, kill - no-ops in simulator
      case 'sleep': return { output: '', exitCode: 0 };
      case 'kill': return { output: '', exitCode: 0 };

      // date, uptime, uname - basic system info
      case 'date': return { output: new Date().toString(), exitCode: 0 };
      case 'uptime': return { output: ' ' + new Date().toLocaleTimeString() + ' up 0 min,  1 user,  load average: 0.00, 0.00, 0.00', exitCode: 0 };
      case 'uname': {
        if (args.includes('-a')) return { output: 'Linux localhost 5.15.0-generic #1 SMP x86_64 GNU/Linux', exitCode: 0 };
        if (args.includes('-r')) return { output: '5.15.0-generic', exitCode: 0 };
        return { output: 'Linux', exitCode: 0 };
      }

      // true/false
      case 'true': return { output: '', exitCode: 0 };
      case 'false': return { output: '', exitCode: 1 };

      // ip (iproute2) — delegated to LinuxIpCommand
      case 'ip': {
        if (!this.ipNetworkCtx) return { output: 'ip: network context not available', exitCode: 1 };
        const out = executeIpCommand(this.ipNetworkCtx, args);
        return { output: out, exitCode: out.includes('Error') || out.includes('unknown') || out.includes('Cannot find') || out.includes('RTNETLINK') || out.includes('does not exist') ? 1 : 0 };
      }

      default: {
        // Check if it's an executable script (./script.sh or /path/to/script)
        if (cmd.startsWith('./') || cmd.startsWith('/')) {
          const absPath = this.vfs.normalizePath(cmd, this.cwd);
          if (this.vfs.exists(absPath)) {
            const result = executeScript(c, cmd, args, (c) => this.execute(c));
            return { output: result.output, exitCode: result.exitCode };
          }
        }

        return { output: `${cmd}: command not found`, exitCode: 127 };
      }
    }
  }

  private handleCrontab(args: string[], stdin?: string): { output: string; exitCode: number } {
    if (args[0] === '-l') {
      const content = this.cron.list();
      if (content === null) return { output: 'no crontab for ' + this.userMgr.currentUser, exitCode: 1 };
      return { output: content, exitCode: 0 };
    }
    if (args[0] === '-r') {
      this.cron.remove();
      return { output: '', exitCode: 0 };
    }
    if (args[0] === '-') {
      // Read from stdin
      if (stdin) this.cron.install(stdin);
      return { output: '', exitCode: 0 };
    }
    return { output: '', exitCode: 0 };
  }

  // ─── Permission checking ──────────────────────────────────────────

  /** Check if current user has permission (r/w/x) on an inode */
  private checkPermission(inode: { permissions: number; uid: number; gid: number }, mode: 'r' | 'w' | 'x'): boolean {
    const uid = this.userMgr.currentUid;
    if (uid === 0) return true; // root can do anything

    const perms = inode.permissions & 0o7777;
    const bit = mode === 'r' ? 4 : mode === 'w' ? 2 : 1;

    // Owner
    if (inode.uid === uid) {
      return !!((perms >> 6) & bit);
    }

    // Group
    const gid = this.userMgr.currentGid;
    const userGroups = this.userMgr.getUserGroups(this.userMgr.currentUser);
    const isInGroup = inode.gid === gid || userGroups.some(g => g.gid === inode.gid);
    if (isInGroup) {
      return !!((perms >> 3) & bit);
    }

    // Other
    return !!(perms & bit);
  }

  // ─── su handler ──────────────────────────────────────────────────

  private handleSu(args: string[]): { output: string; exitCode: number } {
    let loginShell = false;
    let targetUser = 'root';
    for (const arg of args) {
      if (arg === '-' || arg === '-l' || arg === '--login') { loginShell = true; continue; }
      if (!arg.startsWith('-')) targetUser = arg;
    }

    const user = this.userMgr.getUser(targetUser);
    if (!user) return { output: `su: user ${targetUser} does not exist`, exitCode: 1 };
    if (user.shell === '/sbin/nologin' || user.shell === '/usr/sbin/nologin') {
      return { output: `su: user ${targetUser} does not have a login shell`, exitCode: 1 };
    }

    // Save current context to suStack
    this.suStack.push({
      user: this.userMgr.currentUser,
      uid: this.userMgr.currentUid,
      gid: this.userMgr.currentGid,
      cwd: this.cwd,
      umask: this.umask,
    });

    // Switch user
    this.userMgr.currentUser = user.username;
    this.userMgr.currentUid = user.uid;
    this.userMgr.currentGid = user.gid;

    if (loginShell) {
      this.cwd = user.home;
    }

    return { output: '', exitCode: 0 };
  }

  /** Handle exit/logout — pops su stack if in su session */
  handleExit(): { output: string; inSu: boolean } {
    if (this.suStack.length > 0) {
      const prev = this.suStack.pop()!;
      this.userMgr.currentUser = prev.user;
      this.userMgr.currentUid = prev.uid;
      this.userMgr.currentGid = prev.gid;
      this.cwd = prev.cwd;
      this.umask = prev.umask;
      return { output: 'logout', inSu: true };
    }
    return { output: '', inSu: false };
  }

  /** Is the current session inside a `su` context? */
  isInSu(): boolean { return this.suStack.length > 0; }

  /** Get current username for prompt */
  getCurrentUser(): string { return this.userMgr.currentUser; }

  /** Get current UID (0 = root) */
  getCurrentUid(): number { return this.userMgr.currentUid; }

  /** Check password for a user */
  checkPassword(username: string, password: string): boolean {
    return this.userMgr.checkPassword(username, password);
  }

  /** Set password for a user */
  setUserPassword(username: string, password: string): void {
    this.userMgr.setPassword(username, password);
  }

  /** Check if a user exists */
  userExists(username: string): boolean {
    return !!this.userMgr.getUser(username);
  }

  // ─── Improved command handlers ────────────────────────────────────

  private handlePasswd(args: string[]): { output: string; exitCode: number } {
    const c = this.ctx();
    // passwd -l username (lock)
    if (args[0] === '-l' && args[1]) {
      const user = this.userMgr.getUser(args[1]);
      if (!user) return { output: `passwd: user '${args[1]}' does not exist`, exitCode: 1 };
      user.locked = true;
      this.userMgr.syncToFilesystem();
      return { output: 'passwd: password expiry information changed.', exitCode: 0 };
    }
    // passwd -u username (unlock)
    if (args[0] === '-u' && args[1]) {
      const user = this.userMgr.getUser(args[1]);
      if (!user) return { output: `passwd: user '${args[1]}' does not exist`, exitCode: 1 };
      user.locked = false;
      this.userMgr.syncToFilesystem();
      return { output: '', exitCode: 0 };
    }
    // passwd -S username (status)
    if (args[0] === '-S' && args[1]) {
      return { output: cmdPasswd(c, args), exitCode: 0 };
    }
    // passwd username — password change (Terminal handles interactive prompts)
    if (args.length > 0 && !args[0].startsWith('-')) {
      const user = this.userMgr.getUser(args[0]);
      if (!user) return { output: `passwd: user '${args[0]}' does not exist`, exitCode: 1 };
      // Password is set by Terminal after interactive prompt
      return { output: 'passwd: password updated successfully', exitCode: 0 };
    }
    // passwd (no args) — own password change
    return { output: 'passwd: password updated successfully', exitCode: 0 };
  }

  private handleUserdel(args: string[]): { output: string; exitCode: number } {
    let removeHome = false;
    let username = '';
    for (const a of args) {
      if (a === '-r') removeHome = true;
      else if (!a.startsWith('-')) username = a;
    }
    if (!username) return { output: 'userdel: missing username', exitCode: 1 };

    const result = this.userMgr.userdel(username, removeHome);
    if (result) return { output: result, exitCode: 1 };

    const lines: string[] = [];
    if (removeHome) {
      lines.push(`userdel: ${username} mail spool (/var/mail/${username}) not found`);
    }
    return { output: lines.join('\n'), exitCode: 0 };
  }

  private handleAdduser(args: string[]): { output: string; exitCode: number } {
    // Debian-style adduser — creates user, home, skeleton files
    // Interactive password prompts are handled by Terminal.tsx
    let username = '';
    for (const a of args) {
      if (!a.startsWith('-')) { username = a; break; }
    }
    if (!username) return { output: 'adduser: missing username', exitCode: 1 };

    const result = this.userMgr.useradd(username, { m: true, s: '/bin/bash' });
    if (result) return { output: result, exitCode: 1 };

    const user = this.userMgr.getUser(username)!;

    // Create skeleton files in home directory
    this.createSkeletonFiles(user.home, user.uid, user.gid);

    // Return info output only (no password prompts — Terminal handles those)
    const lines = [
      `Adding user \`${username}' ...`,
      `Adding new group \`${username}' (${user.gid}) ...`,
      `Adding new user \`${username}' (${user.uid}) with group \`${username}' ...`,
      `Creating home directory \`${user.home}' ...`,
      `Copying files from \`/etc/skel' ...`,
    ];
    return { output: lines.join('\n'), exitCode: 0 };
  }

  private handleDeluser(args: string[]): { output: string; exitCode: number } {
    let removeHome = false;
    let username = '';
    let fromGroup = '';
    for (let i = 0; i < args.length; i++) {
      if (args[i] === '--remove-home') { removeHome = true; continue; }
      if (!args[i].startsWith('-')) {
        if (!username) username = args[i];
        else fromGroup = args[i];
      }
    }
    if (!username) return { output: 'deluser: missing username', exitCode: 1 };

    // deluser user group — remove user from group
    if (fromGroup) {
      const grp = this.userMgr.getGroup(fromGroup);
      if (!grp) return { output: `deluser: group '${fromGroup}' does not exist`, exitCode: 1 };
      grp.members = grp.members.filter(m => m !== username);
      this.userMgr.syncToFilesystem();
      return { output: `Removing user \`${username}' from group \`${fromGroup}' ...\nDone.`, exitCode: 0 };
    }

    // deluser --remove-home user
    const result = this.userMgr.userdel(username, removeHome);
    if (result) return { output: result, exitCode: 1 };

    const lines: string[] = [];
    if (removeHome) {
      lines.push('Looking for files to backup/remove ...');
      lines.push('Removing files ...');
    }
    lines.push(`Removing user \`${username}' ...`);
    lines.push('Done.');
    return { output: lines.join('\n'), exitCode: 0 };
  }

  private handleGpasswd(args: string[]): { output: string; exitCode: number } {
    // gpasswd -d user group
    if (args[0] === '-d' && args.length >= 3) {
      const group = this.userMgr.getGroup(args[2]);
      if (!group) return { output: `gpasswd: group '${args[2]}' does not exist`, exitCode: 1 };
      group.members = group.members.filter(m => m !== args[1]);
      this.userMgr.syncToFilesystem();
      return { output: `Removing user ${args[1]} from group ${args[2]}`, exitCode: 0 };
    }
    return { output: cmdGpasswd(this.ctx(), args), exitCode: 0 };
  }

  private handleSudoCmd(args: string[]): { output: string; exitCode: number } {
    if (args.length === 0 || args[0] === '-l') {
      // sudo -l: show what current user can do
      const hostname = 'linux-pc';
      const user = this.userMgr.currentUser;
      return {
        output: [
          `Matching Defaults entries for ${user} on ${hostname}:`,
          `    env_reset, mail_badpass, secure_path=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:/snap/bin`,
          ``,
          `User ${user} may run the following commands on ${hostname}:`,
          `    (ALL : ALL) ALL`,
        ].join('\n'),
        exitCode: 0,
      };
    }
    return { output: cmdSudoCheck(this.ctx(), args), exitCode: 0 };
  }

  // ─── Skeleton files ───────────────────────────────────────────────

  private createSkeletonFiles(home: string, uid: number, gid: number): void {
    this.vfs.createFileAt(`${home}/.bash_logout`,
      '# ~/.bash_logout: executed by bash(1) when login shell exits.\n\n' +
      '# when leaving the console clear the screen to increase privacy\n\n' +
      'if [ "$SHLVL" = 1 ]; then\n    [ -x /usr/bin/clear_console ] && /usr/bin/clear_console -q\nfi\n',
      0o644, uid, gid);
    this.vfs.createFileAt(`${home}/.bashrc`,
      '# ~/.bashrc: executed by bash(1) for non-login shells.\n\n' +
      '# If not running interactively, don\'t do anything\ncase $- in\n    *i*) ;;\n      *) return;;\nesac\n\n' +
      '# don\'t put duplicate lines or lines starting with space in the history.\nHISTCONTROL=ignoreboth\n\n' +
      'HISTSIZE=1000\nHISTFILESIZE=2000\n',
      0o644, uid, gid);
    this.vfs.createFileAt(`${home}/.profile`,
      '# ~/.profile: executed by the command interpreter for login shells.\n\n' +
      '# if running bash\nif [ -n "$BASH_VERSION" ]; then\n    # include .bashrc if it exists\n' +
      '    if [ -f "$HOME/.bashrc" ]; then\n\t. "$HOME/.bashrc"\n    fi\nfi\n\n' +
      '# set PATH so it includes user\'s private bin if it exists\nif [ -d "$HOME/bin" ] ; then\n' +
      '    PATH="$HOME/bin:$PATH"\nfi\n',
      0o644, uid, gid);
  }

  // ─── Environment variable expansion ───────────────────────────────

  private expandEnvVars(str: string): string {
    // Only expand variables that exist in env — leave unknown $VARS intact (for scripts)
    return str.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (match, name) => {
      return this.env.has(name) ? this.env.get(name)! : match;
    }).replace(/\$([A-Za-z_][A-Za-z0-9_]*)/g, (match, name) => {
      return this.env.has(name) ? this.env.get(name)! : match;
    });
  }

  /** Get current working directory */
  getCwd(): string { return this.cwd; }

  /** Tab completion: returns matching completions for a partial input */
  getCompletions(partial: string): string[] {
    const trimmed = partial.trimStart();
    if (!trimmed) return [];

    // Split into words — complete the last word
    const parts = trimmed.split(/\s+/);
    const isFirstWord = parts.length <= 1;
    const word = parts[parts.length - 1] || '';

    if (isFirstWord) {
      // Complete command names
      return this.getCommandCompletions(word);
    }

    // Complete file/directory paths
    return this.getPathCompletions(word);
  }

  private getCommandCompletions(prefix: string): string[] {
    const commands = [
      'ls', 'cd', 'cat', 'cp', 'mv', 'rm', 'mkdir', 'rmdir', 'touch', 'chmod',
      'chown', 'chgrp', 'ln', 'find', 'grep', 'head', 'tail', 'wc', 'sort', 'cut',
      'uniq', 'tr', 'awk', 'stat', 'test', 'mkfifo', 'echo', 'pwd', 'tee', 'bash', 'sh',
      'id', 'whoami', 'groups', 'who', 'w', 'last', 'hostname', 'uname', 'sleep', 'kill',
      'useradd', 'usermod', 'userdel', 'passwd', 'chpasswd', 'chage',
      'groupadd', 'groupmod', 'groupdel', 'gpasswd', 'getent', 'sudo',
      'which', 'whereis', 'command', 'locate', 'updatedb',
      'crontab', 'clear', 'reset', 'date', 'uptime', 'umask', 'true', 'false',
      'exit', 'logout', 'help',
      'ifconfig', 'ip', 'ping', 'traceroute', 'netstat', 'ss', 'route', 'arp',
      'dhclient', 'nslookup', 'dig', 'curl', 'wget',
    ];
    if (!prefix) return commands.sort();
    return commands.filter(c => c.startsWith(prefix)).sort();
  }

  private getPathCompletions(word: string): string[] {
    // Determine directory to list and prefix to match
    let dir: string;
    let prefix: string;
    let displayPrefix: string;

    if (word.includes('/')) {
      const lastSlash = word.lastIndexOf('/');
      displayPrefix = word.slice(0, lastSlash + 1);
      prefix = word.slice(lastSlash + 1);
      dir = this.vfs.normalizePath(displayPrefix, this.cwd);
    } else {
      displayPrefix = '';
      prefix = word;
      dir = this.cwd;
    }

    const entries = this.vfs.listDirectory(dir);
    if (!entries) return [];

    const matches: string[] = [];
    for (const entry of entries) {
      if (entry.name === '.' || entry.name === '..') continue;
      if (!prefix || entry.name.startsWith(prefix)) {
        const suffix = entry.inode.type === 'directory' ? '/' : '';
        matches.push(displayPrefix + entry.name + suffix);
      }
    }

    return matches.sort();
  }
}
