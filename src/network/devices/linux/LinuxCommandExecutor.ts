/**
 * Linux command executor - orchestrates parsing and dispatching to command modules.
 */

import { VirtualFileSystem } from './VirtualFileSystem';
import { LinuxUserManager } from './LinuxUserManager';
import { LinuxCronManager } from './LinuxCronManager';
import { LinuxIptablesManager } from './LinuxIptablesManager';
import { LinuxFirewallManager } from './LinuxFirewallManager';
import { LinuxLogManager } from './LinuxLogManager';
import { type ShellContext, cmdTouch, cmdLs, cmdCat, cmdEcho, cmdCp, cmdMv, cmdRm, cmdMkdir, cmdRmdir, cmdLn, cmdPwd, cmdTee, expandGlob } from './LinuxFileCommands';
import { cmdGrep, cmdHead, cmdTail, cmdWc, cmdSort, cmdCut, cmdUniq, cmdTr, cmdAwk } from './LinuxTextCommands';
import { cmdFind, cmdLocate, cmdWhich, cmdWhereis, cmdCommand, cmdUpdatedb } from './LinuxSearchCommands';
import { cmdChmod, cmdChown, cmdChgrp, cmdStat, cmdUmask, cmdTest, cmdMkfifo } from './LinuxPermCommands';
import { cmdUseradd, cmdUsermod, cmdUserdel, cmdPasswd, cmdChpasswd, cmdChage, cmdGroupadd, cmdGroupmod, cmdGroupdel, cmdGpasswd, cmdId, cmdWhoami, cmdGroups, cmdWho, cmdW, cmdLast, cmdGetent, cmdSudoCheck } from './LinuxUserCommands';
import { runScript, runScriptContent } from '@/bash/runtime/ScriptRunner';
import { executeIpCommand, type IpNetworkContext } from './LinuxIpCommand';
import { cmdDf, cmdDu, cmdFree, cmdMount, cmdLsblk } from './LinuxSystemCommands';
import { cmdIfconfig, cmdNetstat, cmdSs, cmdCurl, cmdWget } from './LinuxNetCommands';
import { LinuxProcessManager, type Signal, SIGNAL_NUMBERS } from './LinuxProcessManager';
import { LinuxServiceManager } from './LinuxServiceManager';
import { cmdPs, cmdTop, cmdKill, cmdPidof, cmdPgrep, cmdPkill, cmdSystemctl, cmdService } from './LinuxProcessCommands';

/** Commands that commonly read from stdin when piped. */
const STDIN_COMMANDS = new Set([
  'sort', 'wc', 'grep', 'head', 'tail', 'tr', 'cut', 'uniq', 'tee',
  'awk', 'sed', 'cat', 'xargs', 'less', 'more',
]);

export class LinuxCommandExecutor {
  readonly vfs: VirtualFileSystem;
  readonly userMgr: LinuxUserManager;
  readonly cron: LinuxCronManager;
  readonly iptables: LinuxIptablesManager;
  readonly firewall: LinuxFirewallManager;
  readonly logMgr: LinuxLogManager;
  readonly processMgr: LinuxProcessManager;
  readonly serviceMgr: LinuxServiceManager;
  private ipNetworkCtx: IpNetworkContext | null = null;
  private cwd = '/root';
  private umask = 0o022;
  private isServer: boolean;
  private env: Map<string, string> = new Map();
  /** Registered system processes (pid → {user, command}) for ps command */
  private _systemProcesses: Map<number, { user: string; command: string; startTime: string }> = new Map();
  // Stack for su sessions: stores previous user context
  private suStack: Array<{ user: string; uid: number; gid: number; cwd: string; umask: number }> = [];
  // Command history (like bash HISTFILE)
  private commandHistory: string[] = [];

  constructor(isServer = false) {
    this.vfs = new VirtualFileSystem();
    this.userMgr = new LinuxUserManager(this.vfs);
    this.cron = new LinuxCronManager();
    this.iptables = new LinuxIptablesManager(this.vfs);
    this.firewall = new LinuxFirewallManager(this.vfs, this.iptables);
    this.logMgr = new LinuxLogManager(this.vfs);
    this.processMgr = new LinuxProcessManager();
    this.serviceMgr = new LinuxServiceManager(this.vfs, this.processMgr, { isServer });
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

    // Every interactive shell shows up in the process table as -bash, like a
    // real login shell. Server profiles run as root.
    const shellUser = !isServer ? 'user' : 'root';
    const shellUid = !isServer ? 1000 : 0;
    this.processMgr.spawn({
      command: '-bash',
      comm: '-bash',
      user: shellUser,
      uid: shellUid,
      gid: shellUid,
      tty: 'pts/0',
      cwd: this.cwd,
    });
  }

  /** Set the network context for ip command support */
  setIpNetworkContext(ctx: IpNetworkContext): void {
    this.ipNetworkCtx = ctx;
  }

  /** Register a system process (e.g. Oracle background processes) visible via `ps` */
  registerProcess(pid: number, user: string, command: string): void {
    this._systemProcesses.set(pid, { user, command, startTime: new Date().toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit' }) });
    // Also surface this in the real process table so ps/top see it.
    if (!this.processMgr.get(pid)) {
      const uid = user === 'root' ? 0 : 1;
      this.processMgr.spawn({ command, user, uid, gid: uid });
    }
  }

  /** Clear all registered system processes */
  clearSystemProcesses(): void {
    for (const pid of this._systemProcesses.keys()) {
      this.processMgr.kill(pid, 'SIGKILL');
    }
    this._systemProcesses.clear();
  }

  /** Build the context object passed to ps/top/kill/pgrep/pkill commands. */
  private processCmdContext() {
    return {
      pm: this.processMgr,
      currentUser: this.userMgr.currentUser,
      currentUid: this.userMgr.currentUid,
      tty: 'pts/0',
    };
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
   * Execute a command string through the bash interpreter.
   * Handles variables, control structures, pipes, redirections, functions, etc.
   */
  execute(input: string): string {
    const trimmed = input.trim();
    if (!trimmed) return '';

    // Track command in history (store the raw input, like bash)
    this.commandHistory.push(trimmed);

    // Route through the bash interpreter for full bash syntax support
    const io = this.buildIOContext();
    const initialPwd = this.cwd;
    const initialVars = this.buildEnvVars();
    const result = runScriptContent(
      trimmed,
      'bash',
      [],
      (argv) => this.dispatchFromInterpreter(argv),
      initialVars,
      io,
    );

    // Sync interpreter state back to executor
    if (result.env) {
      // Sync PWD → this.cwd only if the interpreter's cd builtin changed it
      // (not if an external command like su changed this.cwd through dispatch)
      const interpPwd = result.env['PWD'];
      if (interpPwd && interpPwd !== initialPwd && this.cwd === initialPwd) {
        // The interpreter changed PWD but dispatch didn't change this.cwd
        // → the cd builtin was used; validate and apply
        const inode = this.vfs.resolveInode(interpPwd);
        if (inode && inode.type === 'directory') {
          this.cwd = interpPwd;
        }
      }
      // Sync variables back to executor's env
      for (const [key, value] of Object.entries(result.env)) {
        // Skip internal/special vars and positional params
        if (/^\d+$/.test(key) || ['?', '$', '!', '@', '#', '*', '0', 'PWD', 'OLDPWD'].includes(key)) continue;
        if (value !== initialVars[key]) {
          this.env.set(key, value);
        }
      }
    }

    return result.output;
  }

  /**
   * Bridge between the bash interpreter and the command dispatcher.
   * Called by the interpreter for external (non-builtin) commands.
   */
  private dispatchFromInterpreter(argv: string[]): { output: string; exitCode: number } {
    if (argv.length === 0) return { output: '', exitCode: 0 };

    // The last argument may be pipe input (passed by the interpreter)
    // Detect: if there are more args than expected and the last contains newlines, treat as stdin
    const cmd = argv[0];
    const args = argv.slice(1);

    // Handle sudo prefix
    let cmdArgs = [...argv];
    let isSudo = false;
    let savedUser: { user: string; uid: number; gid: number; cwd: string } | null = null;
    if (cmdArgs[0] === 'sudo') {
      isSudo = true;
      cmdArgs = cmdArgs.slice(1);
      if (cmdArgs.length === 0) return { output: 'usage: sudo [-u user] command\n       sudo -l', exitCode: 1 };
      if (cmdArgs[0] === '-l') return this.dispatch('sudo', cmdArgs, undefined, true);
      if (!this.canSudo()) {
        return {
          output: `${this.userMgr.currentUser} is not in the sudoers file. This incident will be reported.`,
          exitCode: 1,
        };
      }
      let sudoTargetUser: string | null = null;
      if (cmdArgs[0] === '-u' && cmdArgs.length >= 3) {
        sudoTargetUser = cmdArgs[1];
        cmdArgs = cmdArgs.slice(2);
      }
      savedUser = { user: this.userMgr.currentUser, uid: this.userMgr.currentUid, gid: this.userMgr.currentGid, cwd: this.cwd };
      if (sudoTargetUser) {
        const targetUserEntry = this.userMgr.getUser(sudoTargetUser);
        if (targetUserEntry) {
          this.userMgr.currentUser = targetUserEntry.username;
          this.userMgr.currentUid = targetUserEntry.uid;
          this.userMgr.currentGid = targetUserEntry.gid;
        } else {
          return { output: `sudo: unknown user: ${sudoTargetUser}`, exitCode: 1 };
        }
      } else {
        this.userMgr.currentUser = 'root';
        this.userMgr.currentUid = 0;
        this.userMgr.currentGid = 0;
      }
    }

    if (cmdArgs.length === 0) {
      if (savedUser) { this.userMgr.currentUser = savedUser.user; this.userMgr.currentUid = savedUser.uid; this.userMgr.currentGid = savedUser.gid; }
      return { output: '', exitCode: 0 };
    }

    const actualCmd = isSudo ? cmdArgs[0] : cmd;
    const actualArgs = isSudo ? cmdArgs.slice(1) : args;

    // Detect pipe input: the interpreter appends stdin content as last arg
    let stdin: string | undefined;
    if (actualArgs.length > 0) {
      const lastArg = actualArgs[actualArgs.length - 1];
      // Heuristic: if last arg contains newlines, it's likely pipe input
      if (lastArg?.includes('\n')) {
        stdin = lastArg;
        actualArgs.pop();
      } else if (lastArg && STDIN_COMMANDS.has(actualCmd) && lastArg.includes(' ')) {
        // For text processing commands, multi-word content without newlines is also stdin
        stdin = lastArg;
        actualArgs.pop();
      }
    }

    let result: { output: string; exitCode: number };
    try {
      result = this.dispatch(actualCmd, actualArgs, stdin, isSudo);
    } catch {
      result = { output: `${actualCmd}: error`, exitCode: 1 };
    }

    // Restore user after sudo — BUT NOT if the command was `su` (su manages its own context)
    if (savedUser && actualCmd !== 'su') {
      this.userMgr.currentUser = savedUser.user;
      this.userMgr.currentUid = savedUser.uid;
      this.userMgr.currentGid = savedUser.gid;
    }
    // For sudo su: fix the suStack to return to the original (pre-sudo) user, not root
    if (savedUser && actualCmd === 'su' && this.suStack.length > 0) {
      const top = this.suStack[this.suStack.length - 1];
      top.user = savedUser.user;
      top.uid = savedUser.uid;
      top.gid = savedUser.gid;
      top.cwd = savedUser.cwd;
    }

    return result;
  }

  /** Build an IOContext for the bash interpreter. */
  private buildIOContext(): import('@/bash/interpreter/BashInterpreter').IOContext {
    return {
      writeFile: (path: string, content: string, append: boolean) => {
        const absPath = this.vfs.normalizePath(path, this.cwd);
        // Check if target is a directory
        const existing = this.vfs.resolveInode(absPath);
        if (existing && existing.type === 'directory') {
          throw new Error(`bash: ${path}: Is a directory`);
        }
        this.vfs.writeFile(absPath, content, this.ctx().uid, this.ctx().gid, this.umask, append);
      },
      readFile: (path: string) => {
        const absPath = this.vfs.normalizePath(path, this.cwd);
        return this.vfs.readFile(absPath);
      },
      resolvePath: (path: string) => {
        return this.vfs.normalizePath(path, this.cwd);
      },
      stat: (path: string) => {
        const absPath = this.vfs.normalizePath(path, this.cwd);
        const inode = this.vfs.resolveInode(absPath);
        if (!inode) return null;
        return { type: inode.type === 'directory' ? 'directory' as const : 'file' as const };
      },
    };
  }

  /** Build initial environment variables for the bash interpreter. */
  private buildEnvVars(): Record<string, string> {
    const vars: Record<string, string> = {
      HOME: this.userMgr.currentUid === 0 ? '/root' : `/home/${this.userMgr.currentUser}`,
      PWD: this.cwd,
      USER: this.userMgr.currentUser,
      LOGNAME: this.userMgr.currentUser,
      UID: String(this.userMgr.currentUid),
      SHELL: '/bin/bash',
      PATH: '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
    };
    // Include exported env vars
    for (const [k, v] of this.env) {
      vars[k] = v;
    }
    return vars;
  }

  private dispatch(cmd: string, args: string[], stdin?: string, isSudo = false): { output: string; exitCode: number } {
    const c = this.ctx();

    // Root-only commands — reject if not root
    const rootOnlyCmds = ['useradd', 'adduser', 'usermod', 'userdel', 'deluser',
      'groupadd', 'groupmod', 'groupdel', 'chpasswd', 'chage', 'chown', 'chgrp', 'ufw',
      'iptables', 'iptables-save', 'iptables-restore'];
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
        // If no file args and stdin is provided, output stdin (cat from stdin)
        const fileArgs = args.filter(a => !a.startsWith('-'));
        if (fileArgs.length === 0 && stdin) {
          const content = stdin.endsWith('\n') ? stdin.slice(0, -1) : stdin;
          return { output: content, exitCode: 0 };
        }
        // Permission check: can user read this file?
        for (const arg of fileArgs) {
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
      case 'chfn': return this.handleChfn(args);
      case 'finger': return this.handleFinger(args);
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
        const execCmd = (argv: string[]) => this.dispatchFromInterpreter(argv);
        if (args[0] === '-c' && args.length > 1) {
          const result = runScriptContent(args[1], cmd, args.slice(2), execCmd, this.buildEnvVars(), this.buildIOContext());
          return { output: result.output, exitCode: result.exitCode };
        }
        if (args.length > 0) {
          const result = runScript(c, args[0], args.slice(1), execCmd);
          return { output: result.output, exitCode: result.exitCode };
        }
        return { output: '', exitCode: 0 };
      }

      // UFW (Uncomplicated Firewall)
      case 'ufw': {
        const out = this.firewall.execute(args);
        return { output: out, exitCode: out.startsWith('ERROR') ? 1 : 0 };
      }

      // iptables — real packet filtering firewall
      case 'iptables': {
        const result = this.iptables.execute(args);
        return { output: result.output, exitCode: result.exitCode };
      }

      // iptables-save — dump all rules in iptables-save format
      case 'iptables-save': {
        return { output: this.iptables.executeSave(), exitCode: 0 };
      }

      // iptables-restore — load rules from stdin
      case 'iptables-restore': {
        const input = stdin ?? '';
        if (!input) return { output: 'iptables-restore: unable to read from stdin', exitCode: 1 };
        const result = this.iptables.executeRestore(input);
        return { output: result.output, exitCode: result.exitCode };
      }

      // Logging commands
      case 'logger': {
        const out = this.logMgr.executeLogger(args, this.userMgr.currentUser);
        return { output: out, exitCode: out ? 1 : 0 };
      }
      case 'journalctl': {
        const out = this.logMgr.executeJournalctl(args);
        return { output: out, exitCode: out.startsWith('Invalid') ? 1 : 0 };
      }
      case 'dmesg': {
        const out = this.logMgr.executeDmesg(args, this.userMgr.currentUid);
        return { output: out, exitCode: out.includes('Permission denied') ? 1 : 0 };
      }

      // Hostname
      case 'hostname':
        return { output: args[0] || 'localhost', exitCode: 0 };

      // history — command history management
      case 'history': return this.handleHistory(args);

      // clear - send ANSI escape to clear terminal
      case 'clear': return { output: '\x1b[2J\x1b[H', exitCode: 0 };
      case 'reset': return { output: '\x1b[2J\x1b[H', exitCode: 0 };

      // Sleep — non-blocking simulator no-op
      case 'sleep': return { output: '', exitCode: 0 };

      // kill — send signal via process manager
      case 'kill': {
        const r = cmdKill(args, this.processCmdContext());
        return r;
      }
      case 'pkill': {
        const r = cmdPkill(args, this.processCmdContext());
        return r;
      }
      case 'pgrep': {
        const r = cmdPgrep(args, this.processCmdContext());
        return r;
      }
      case 'pidof': {
        const r = cmdPidof(args, this.processCmdContext());
        return r;
      }

      // ps — process listing backed by ProcessManager
      case 'ps': return { output: cmdPs(args, this.processCmdContext()), exitCode: 0 };

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

      // ipsec (strongSwan) — IPsec management
      case 'ipsec':
        return this.handleIPSec(args);

      // ── System administration commands ──────────────────────────────
      case 'systemctl': return cmdSystemctl(args, this.serviceMgr);
      case 'service': return cmdService(args, this.serviceMgr);
      case 'df': return { output: cmdDf(c, args), exitCode: 0 };
      case 'du': return { output: cmdDu(c, args), exitCode: 0 };
      case 'free': return { output: cmdFree(args), exitCode: 0 };
      case 'mount': return { output: cmdMount(c, args), exitCode: 0 };
      case 'umount': return { output: '', exitCode: 0 };
      case 'lsblk': return { output: cmdLsblk(args), exitCode: 0 };
      case 'top': return { output: cmdTop(args, this.processCmdContext()), exitCode: 0 };
      case 'htop': return { output: cmdTop(args, this.processCmdContext()), exitCode: 0 };

      // ── Network commands ────────────────────────────────────────────
      case 'ifconfig': return { output: cmdIfconfig(args, this.ipNetworkCtx), exitCode: 0 };
      case 'netstat': return { output: cmdNetstat(args, this.ipNetworkCtx, this.isServer), exitCode: 0 };
      case 'ss': return { output: cmdSs(args, this.isServer), exitCode: 0 };
      case 'curl': return { output: cmdCurl(args), exitCode: 0 };
      case 'wget': return { output: cmdWget(args), exitCode: 0 };
      // @deprecated — The following stubs (ping, traceroute, nslookup, dig,
      // host) are retained only as a fallback for scripts executed inside the
      // bash interpreter. Since Phase 3, LinuxMachine intercepts these
      // commands *before* they reach the executor and routes them through the
      // real EndHost network stack (see linux/commands/net/Ping.ts, etc.).
      // These stubs will never fire for interactive terminal commands.
      case 'ping': {
        const host = args.filter(a => !a.startsWith('-'))[0];
        if (!host) return { output: 'ping: usage error: Destination address required', exitCode: 1 };
        return { output: `PING ${host} (${host}) 56(84) bytes of data.\n64 bytes from ${host}: icmp_seq=1 ttl=64 time=0.5 ms\n64 bytes from ${host}: icmp_seq=2 ttl=64 time=0.4 ms\n\n--- ${host} ping statistics ---\n2 packets transmitted, 2 received, 0% packet loss, time 1001ms\nrtt min/avg/max/mdev = 0.4/0.45/0.5/0.05 ms`, exitCode: 0 };
      }
      case 'traceroute': {
        const host = args.filter(a => !a.startsWith('-'))[0];
        if (!host) return { output: 'Usage: traceroute host', exitCode: 1 };
        return { output: `traceroute to ${host}, 30 hops max, 60 byte packets\n 1  gateway (10.0.0.1)  0.5 ms  0.4 ms  0.3 ms\n 2  ${host}  1.2 ms  1.1 ms  1.0 ms`, exitCode: 0 };
      }
      case 'nslookup':
      case 'dig':
      case 'host': {
        const host = args.filter(a => !a.startsWith('-'))[0];
        if (!host) return { output: `Usage: ${cmd} hostname`, exitCode: 1 };
        return { output: `Server:\t\t127.0.0.53\nAddress:\t127.0.0.53#53\n\nNon-authoritative answer:\nName:\t${host}\nAddress: 93.184.216.34`, exitCode: 0 };
      }

      // ── Miscellaneous common commands ────────────────────────────────
      case 'apt':
      case 'apt-get': {
        const sub = args[0] || '';
        if (sub === 'update') return { output: 'Hit:1 http://archive.ubuntu.com/ubuntu jammy InRelease\nReading package lists... Done', exitCode: 0 };
        if (sub === 'install') return { output: `Reading package lists... Done\nBuilding dependency tree... Done\n${args.slice(1).join(', ')} is already the newest version.\n0 upgraded, 0 newly installed, 0 to remove and 0 not upgraded.`, exitCode: 0 };
        if (sub === 'upgrade') return { output: 'Reading package lists... Done\nBuilding dependency tree... Done\nCalculating upgrade... Done\n0 upgraded, 0 newly installed, 0 to remove and 0 not upgraded.', exitCode: 0 };
        if (sub === 'remove' || sub === 'purge') return { output: 'Reading package lists... Done\nBuilding dependency tree... Done\n0 upgraded, 0 newly installed, 0 to remove and 0 not upgraded.', exitCode: 0 };
        if (sub === 'list' && args.includes('--installed')) return { output: 'Listing... Done\nbash/jammy,now 5.1-6ubuntu1 amd64 [installed]\ncoreutils/jammy,now 8.32-4.1ubuntu1 amd64 [installed]\nopenssl/jammy,now 3.0.2-0ubuntu1 amd64 [installed]', exitCode: 0 };
        return { output: `Usage: ${cmd} [update|install|upgrade|remove|list]`, exitCode: 0 };
      }
      case 'dpkg': {
        if (args[0] === '-l' || args[0] === '--list') return { output: 'Desired=Unknown/Install/Remove/Purge/Hold\n| Status=Not/Inst/Conf-files/Unpacked/halF-conf/Half-inst/trig-aWait/Trig-pend\n||/ Name                Version          Architecture Description\n+++-===================-================-============-================================\nii  bash                5.1-6ubuntu1     amd64        GNU Bourne Again SHell\nii  coreutils           8.32-4.1ubuntu1  amd64        GNU core utilities\nii  openssl             3.0.2-0ubuntu1   amd64        Secure Sockets Layer toolkit', exitCode: 0 };
        return { output: 'dpkg: need an action option\nUse dpkg --help for help.', exitCode: 1 };
      }
      case 'lscpu': return { output: 'Architecture:                    x86_64\nCPU op-mode(s):                  32-bit, 64-bit\nByte Order:                      Little Endian\nAddress sizes:                   46 bits physical, 48 bits virtual\nCPU(s):                          2\nOn-line CPU(s) list:             0,1\nThread(s) per core:              1\nCore(s) per socket:              2\nSocket(s):                       1\nModel name:                      Intel(R) Xeon(R) CPU E5-2686 v4 @ 2.30GHz\nCPU MHz:                         2300.000\nBogoMIPS:                        4600.00\nL1d cache:                       64 KiB\nL1i cache:                       64 KiB\nL2 cache:                        512 KiB\nL3 cache:                        46080 KiB', exitCode: 0 };
      case 'lsof': return { output: 'COMMAND   PID   USER   FD   TYPE DEVICE SIZE/OFF NODE NAME\nsystemd     1   root  cwd    DIR    8,1     4096    2 /\nsshd      985   root    3u  IPv4  15432      0t0  TCP *:22 (LISTEN)', exitCode: 0 };
      case 'file': {
        const target = args.filter(a => !a.startsWith('-'))[0];
        if (!target) return { output: 'Usage: file [-options] file...', exitCode: 1 };
        return { output: `${target}: ASCII text`, exitCode: 0 };
      }
      case 'md5sum':
      case 'sha256sum':
      case 'sha1sum': {
        const target = args.filter(a => !a.startsWith('-'))[0];
        if (!target) return { output: `${cmd}: missing file operand`, exitCode: 1 };
        const hash = Array.from({length: cmd === 'sha256sum' ? 64 : 32}, () => Math.floor(Math.random() * 16).toString(16)).join('');
        return { output: `${hash}  ${target}`, exitCode: 0 };
      }
      case 'tar': return { output: '', exitCode: 0 };
      case 'gzip':
      case 'gunzip':
      case 'zip':
      case 'unzip':
        return { output: '', exitCode: 0 };
      case 'scp':
      case 'rsync':
        return { output: '', exitCode: 0 };
      case 'ssh': {
        const host = args.filter(a => !a.startsWith('-'))[0];
        if (!host) return { output: 'usage: ssh [-options] destination [command]', exitCode: 1 };
        return { output: `ssh: connect to host ${host} port 22: Connection refused`, exitCode: 255 };
      }
      case 'xargs': {
        if (!stdin) return { output: '', exitCode: 0 };
        const xCmd = args[0] || 'echo';
        return { output: stdin.split('\n').filter(l => l.trim()).map(l => `${xCmd} ${l.trim()}`).join('\n'), exitCode: 0 };
      }
      case 'tput':
      case 'stty':
      case 'alias':
      case 'unalias':
      case 'type':
      case 'set':
      case 'unset':
      case 'declare':
      case 'local':
      case 'readonly':
        return { output: '', exitCode: 0 };
      case 'seq': {
        const nums = args.filter(a => !a.startsWith('-')).map(Number);
        if (nums.length === 1) return { output: Array.from({length: nums[0]}, (_, i) => i + 1).join('\n'), exitCode: 0 };
        if (nums.length === 2) return { output: Array.from({length: nums[1] - nums[0] + 1}, (_, i) => nums[0] + i).join('\n'), exitCode: 0 };
        if (nums.length === 3) { const r: number[] = []; for (let i = nums[0]; i <= nums[2]; i += nums[1]) r.push(i); return { output: r.join('\n'), exitCode: 0 }; }
        return { output: 'seq: missing operand', exitCode: 1 };
      }
      case 'rev': return { output: (stdin || '').split('\n').map(l => l.split('').reverse().join('')).join('\n'), exitCode: 0 };
      case 'basename': return { output: (args[0] || '').split('/').pop() || '', exitCode: 0 };
      case 'dirname': { const p = args[0] || ''; const idx = p.lastIndexOf('/'); return { output: idx > 0 ? p.slice(0, idx) : (idx === 0 ? '/' : '.'), exitCode: 0 }; }
      case 'readlink': return { output: args.filter(a => !a.startsWith('-'))[0] || '', exitCode: 0 };
      case 'mktemp': return { output: '/tmp/tmp.' + Math.random().toString(36).slice(2, 12), exitCode: 0 };

      default: {
        // Check if it's an executable script (./script.sh or /path/to/script)
        if (cmd.startsWith('./') || cmd.startsWith('/')) {
          const absPath = this.vfs.normalizePath(cmd, this.cwd);
          if (this.vfs.exists(absPath)) {
            const result = runScript(c, cmd, args, (argv) => this.dispatchFromInterpreter(argv));
            return { output: result.output, exitCode: result.exitCode };
          }
        }

        return { output: `${cmd}: command not found`, exitCode: 127 };
      }
    }
  }

  private handleHistory(args: string[]): { output: string; exitCode: number } {
    // history -c : clear history
    if (args[0] === '-c') {
      this.commandHistory.length = 0;
      return { output: '', exitCode: 0 };
    }

    // history -d N : delete entry at position N (1-based)
    if (args[0] === '-d') {
      const pos = parseInt(args[1], 10);
      if (isNaN(pos) || pos < 1 || pos > this.commandHistory.length) {
        return { output: `bash: history: ${args[1] || ''}: history position out of range`, exitCode: 1 };
      }
      this.commandHistory.splice(pos - 1, 1);
      return { output: '', exitCode: 0 };
    }

    // history -w : write history to ~/.bash_history
    if (args[0] === '-w') {
      const home = this.userMgr.getUser(this.userMgr.currentUser)?.home || '/root';
      const histFile = home + '/.bash_history';
      this.vfs.writeFile(histFile, this.commandHistory.join('\n'), this.userMgr.currentUid, this.userMgr.currentGid, this.umask);
      return { output: '', exitCode: 0 };
    }

    // history -r : read history from ~/.bash_history (append to current history)
    if (args[0] === '-r') {
      const home = this.userMgr.getUser(this.userMgr.currentUser)?.home || '/root';
      const histFile = home + '/.bash_history';
      const content = this.vfs.readFile(histFile);
      if (content) {
        const lines = content.split('\n').filter(l => l.length > 0);
        this.commandHistory.push(...lines);
      }
      return { output: '', exitCode: 0 };
    }

    // history [N] : display last N entries (or all)
    let count = this.commandHistory.length;
    if (args.length > 0 && !args[0].startsWith('-')) {
      const n = parseInt(args[0], 10);
      if (!isNaN(n) && n > 0) {
        count = Math.min(n, this.commandHistory.length);
      }
    }

    const start = this.commandHistory.length - count;
    const lines: string[] = [];
    for (let i = start; i < this.commandHistory.length; i++) {
      const num = (i + 1).toString().padStart(5);
      lines.push(`${num}  ${this.commandHistory[i]}`);
    }
    return { output: lines.join('\n'), exitCode: 0 };
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

  /** Reset terminal session — clear su stack and restore original user/cwd */
  resetSession(): void {
    // Pop all su contexts to return to original user
    while (this.suStack.length > 0) {
      const prev = this.suStack.pop()!;
      this.userMgr.currentUser = prev.user;
      this.userMgr.currentUid = prev.uid;
      this.userMgr.currentGid = prev.gid;
      this.cwd = prev.cwd;
      this.umask = prev.umask;
    }
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

  /** Set GECOS fields for a user */
  setUserGecos(username: string, fullName: string, room: string, workPhone: string, homePhone: string, other: string): void {
    this.userMgr.setUserGecos(username, fullName, room, workPhone, homePhone, other);
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
    let gecos: string | undefined;
    let disabledPassword = false;

    for (let i = 0; i < args.length; i++) {
      if (args[i] === '--gecos') { gecos = args[++i]; continue; }
      if (args[i] === '--disabled-password') { disabledPassword = true; continue; }
      if (args[i] === '--disabled-login') { disabledPassword = true; continue; }
      if (!args[i].startsWith('-')) { username = args[i]; }
    }
    if (!username) return { output: 'adduser: missing username', exitCode: 1 };

    const result = this.userMgr.useradd(username, { m: true, s: '/bin/bash', c: gecos });
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

  private handleChfn(args: string[]): { output: string; exitCode: number } {
    let f: string | undefined, r: string | undefined, w: string | undefined, h: string | undefined;
    let username = '';

    for (let i = 0; i < args.length; i++) {
      switch (args[i]) {
        case '-f': f = args[++i]; break;
        case '-r': r = args[++i]; break;
        case '-w': w = args[++i]; break;
        case '-h': h = args[++i]; break;
        default:
          if (!args[i].startsWith('-')) username = args[i];
          break;
      }
    }

    if (!username) username = this.userMgr.currentUser;
    const result = this.userMgr.chfn(username, { f, r, w, h });
    if (result) return { output: result, exitCode: 1 };
    return { output: '', exitCode: 0 };
  }

  private handleFinger(args: string[]): { output: string; exitCode: number } {
    const username = args.find(a => !a.startsWith('-'));
    const out = this.userMgr.finger(username);
    return { output: out, exitCode: out.includes('no such user') ? 1 : 0 };
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
      const userGroups = this.userMgr.getUserGroups(user);
      const isSudoer = user === 'root' || userGroups.some(g => g.name === 'sudo');
      if (!isSudoer) {
        return {
          output: `${user} is not in the sudoers file. This incident will be reported.`,
          exitCode: 1,
        };
      }
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

  /** Check if the current user is allowed to use sudo */
  canSudo(): boolean {
    const user = this.userMgr.currentUser;
    if (user === 'root' || this.userMgr.currentUid === 0) return true;
    const userGroups = this.userMgr.getUserGroups(user);
    return userGroups.some(g => g.name === 'sudo');
  }

  // ─── IPSec (strongSwan) ─────────────────────────────────────────

  private ipsecStarted = false;

  private handleIPSec(args: string[]): { output: string; exitCode: number } {
    if (args.length === 0) {
      return { output: 'Usage: ipsec <command> [arguments]\n\nCommands:\n  start        start the IPsec subsystem\n  stop         stop the IPsec subsystem\n  restart      restart the IPsec subsystem\n  status       show IPsec status\n  statusall    show detailed IPsec status\n  up <conn>    bring up a connection\n  down <conn>  tear down a connection\n  reload       reload configuration\n  version      show strongSwan version', exitCode: 0 };
    }

    switch (args[0]) {
      case 'start':
        this.ipsecStarted = true;
        return { output: 'Starting strongSwan 5.9.8 IPsec [starter]...', exitCode: 0 };
      case 'stop':
        this.ipsecStarted = false;
        return { output: 'Stopping strongSwan IPsec...', exitCode: 0 };
      case 'restart':
        this.ipsecStarted = true;
        return { output: 'Stopping strongSwan IPsec...\nStarting strongSwan 5.9.8 IPsec [starter]...', exitCode: 0 };
      case 'reload':
        if (!this.ipsecStarted) return { output: 'IPsec is not running', exitCode: 1 };
        return { output: 'Reloading strongSwan IPsec configuration...', exitCode: 0 };
      case 'status':
        if (!this.ipsecStarted) return { output: 'IPsec is not running', exitCode: 1 };
        return { output: 'Security Associations (0 up, 0 connecting):\n  none', exitCode: 0 };
      case 'statusall':
        if (!this.ipsecStarted) return { output: 'IPsec is not running', exitCode: 1 };
        return {
          output: 'Status of IKE charon daemon (strongSwan 5.9.8, Linux 5.15.0-generic, x86_64):\n' +
            '  uptime: 0 seconds, since now\n' +
            '  worker threads: 16 of 16 idle, 5/0/0/0 working, job queue: 0/0/0/0\n' +
            '  loaded plugins: charon aes sha2 sha1 md5 hmac pem x509 kernel-netlink\n' +
            'Security Associations (0 up, 0 connecting):\n  none',
          exitCode: 0,
        };
      case 'up': {
        if (!this.ipsecStarted) return { output: 'IPsec is not running', exitCode: 1 };
        const conn = args[1] || '';
        if (!conn) return { output: 'Usage: ipsec up <connection-name>', exitCode: 1 };
        return { output: `initiating IKE_SA ${conn}[1] to 0.0.0.0\ngenerating IKE_SA_INIT request`, exitCode: 0 };
      }
      case 'down': {
        if (!this.ipsecStarted) return { output: 'IPsec is not running', exitCode: 1 };
        const conn = args[1] || '';
        if (!conn) return { output: 'Usage: ipsec down <connection-name>', exitCode: 1 };
        return { output: `closing IKE_SA ${conn}[1]`, exitCode: 0 };
      }
      case 'version':
        return { output: 'Linux strongSwan U5.9.8/K5.15.0-generic\nUniversity of Applied Sciences Rapperswil, Switzerland', exitCode: 0 };
      default:
        return { output: `unknown command: ${args[0]}`, exitCode: 1 };
    }
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

  /** Read a file from the virtual filesystem (returns null if not found) */
  readFile(path: string): string | null {
    const absPath = this.vfs.normalizePath(path, this.cwd);
    return this.vfs.readFile(absPath);
  }

  /** Tab completion: returns matching completions for a partial input */
  getCompletions(partial: string): string[] {
    const trimmed = partial.trimStart();
    if (!trimmed) return [];

    // Split into words — complete the last word
    const parts = trimmed.split(/\s+/);
    const word = parts[parts.length - 1] || '';

    // Environment variable completion: $VAR or ${VAR
    const dollarMatch = word.match(/^(\$\{?)([A-Za-z_][A-Za-z0-9_]*)?$/);
    if (dollarMatch) {
      const sigil = dollarMatch[1];
      const varPrefix = dollarMatch[2] || '';
      const closeBrace = sigil === '${' ? '}' : '';
      const names = this.getEnvVarNames(varPrefix);
      return names.map(n => sigil + n + closeBrace).sort();
    }

    const isFirstWord = parts.length <= 1;
    // After `sudo`, complete commands for the next word
    const afterSudo = parts.length === 2 && parts[0] === 'sudo';

    if (isFirstWord || afterSudo) {
      const prefix = isFirstWord ? word : parts[1];
      // For script execution ./foo, or absolute/home paths, complete as path
      if (prefix.startsWith('./') || prefix.startsWith('/') || prefix.startsWith('~')) {
        return this.getPathCompletions(prefix);
      }
      return this.getCommandCompletions(prefix);
    }

    // Complete file/directory paths
    return this.getPathCompletions(word);
  }

  private getEnvVarNames(prefix: string): string[] {
    const all = new Set<string>(Object.keys(this.buildEnvVars()));
    const names: string[] = [];
    for (const key of all) {
      if (!prefix || key.startsWith(prefix)) names.push(key);
    }
    return names;
  }

  private getCommandCompletions(prefix: string): string[] {
    const commands = [
      // File/dir basics
      'ls', 'cd', 'cat', 'cp', 'mv', 'rm', 'mkdir', 'rmdir', 'touch', 'chmod',
      'chown', 'chgrp', 'ln', 'find', 'grep', 'egrep', 'fgrep', 'head', 'tail',
      'wc', 'sort', 'cut', 'uniq', 'tr', 'awk', 'sed', 'stat', 'test', 'mkfifo',
      'tee', 'basename', 'dirname', 'readlink', 'realpath', 'file', 'xargs',
      'less', 'more', 'diff', 'cmp', 'patch',
      // Shell builtins and basics
      'echo', 'printf', 'pwd', 'bash', 'sh', 'export', 'unset', 'source',
      'alias', 'unalias', 'set', 'shift', 'declare', 'readonly', 'local',
      'read', 'type', 'eval', 'exec', 'trap', 'return', 'break', 'continue',
      'let', 'history', 'jobs', 'bg', 'fg', 'wait', 'disown',
      // Users and groups
      'id', 'whoami', 'groups', 'who', 'w', 'last', 'hostname', 'uname', 'sleep', 'kill',
      'useradd', 'usermod', 'userdel', 'passwd', 'chpasswd', 'chage',
      'groupadd', 'groupmod', 'groupdel', 'gpasswd', 'getent', 'sudo', 'su',
      'login', 'logout',
      // Lookup
      'which', 'whereis', 'command', 'locate', 'updatedb', 'apropos', 'man', 'info',
      // System / processes / time
      'crontab', 'clear', 'reset', 'date', 'uptime', 'umask', 'true', 'false',
      'exit', 'help', 'ps', 'top', 'htop', 'free', 'df', 'du', 'mount', 'umount',
      'systemctl', 'service', 'journalctl', 'dmesg', 'lsof', 'fuser', 'nice',
      'renice', 'timeout', 'watch', 'env', 'printenv',
      // Networking
      'ifconfig', 'ip', 'ping', 'ping6', 'traceroute', 'tracepath', 'netstat',
      'ss', 'route', 'arp', 'dhclient', 'nslookup', 'dig', 'host', 'curl', 'wget',
      'ssh', 'scp', 'sftp', 'rsync', 'telnet', 'nc', 'ncat',
      'iptables', 'iptables-save', 'iptables-restore', 'nft', 'ufw', 'firewall-cmd',
      // Editors
      'nano', 'vi', 'vim', 'emacs', 'ed',
      // Archives / packages
      'tar', 'gzip', 'gunzip', 'zip', 'unzip', 'bzip2', 'bunzip2', 'xz', 'unxz',
      'apt', 'apt-get', 'apt-cache', 'dpkg', 'snap',
    ];
    // Dedup
    const unique = Array.from(new Set(commands));
    if (!prefix) return unique.sort();
    return unique.filter(c => c.startsWith(prefix)).sort();
  }

  private getHomeDir(): string {
    return this.userMgr.currentUid === 0 ? '/root' : `/home/${this.userMgr.currentUser}`;
  }

  private expandTilde(word: string): string {
    if (word === '~') return this.getHomeDir();
    if (word.startsWith('~/')) return this.getHomeDir() + word.slice(1);
    return word;
  }

  private getPathCompletions(word: string): string[] {
    // Determine directory to list and prefix to match
    let dir: string;
    let prefix: string;
    let displayPrefix: string;

    // Expand ~ for directory resolution but preserve display as typed
    const expanded = this.expandTilde(word);

    if (word.includes('/')) {
      const lastSlash = word.lastIndexOf('/');
      displayPrefix = word.slice(0, lastSlash + 1);
      prefix = word.slice(lastSlash + 1);
      const expandedDisplay = this.expandTilde(displayPrefix);
      dir = this.vfs.normalizePath(expandedDisplay, this.cwd);
    } else if (word === '~') {
      // Complete "~" itself to the home directory
      return [this.getHomeDir() + '/'];
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
      // Hide dotfiles unless prefix starts with a dot
      if (!prefix.startsWith('.') && entry.name.startsWith('.')) continue;
      if (!prefix || entry.name.startsWith(prefix)) {
        const suffix = entry.inode.type === 'directory' ? '/' : '';
        matches.push(displayPrefix + entry.name + suffix);
      }
    }

    return matches.sort();
  }
}
