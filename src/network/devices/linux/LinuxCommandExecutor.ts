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

export class LinuxCommandExecutor {
  readonly vfs: VirtualFileSystem;
  readonly userMgr: LinuxUserManager;
  readonly cron: LinuxCronManager;
  private cwd = '/root';
  private umask = 0o022;
  private isServer: boolean;

  constructor(isServer = false) {
    this.vfs = new VirtualFileSystem();
    this.userMgr = new LinuxUserManager(this.vfs);
    this.cron = new LinuxCronManager();
    this.isServer = isServer;

    if (!isServer) {
      // Regular PC: default user is 'user' (non-root)
      const uid = 1000;
      const gid = 1000;
      this.userMgr.useradd('user', { m: true, s: '/bin/bash' });
      this.userMgr.currentUser = 'user';
      this.userMgr.currentUid = uid;
      this.userMgr.currentGid = gid;
      this.cwd = '/home/user';
    }
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

    for (const segment of chain.pipeline) {
      const cmd = segment.commands[0];
      const result = this.executeSingleCommand(cmd, pipeInput);
      lastOutput = result.output;
      exitCode = result.exitCode;
      pipeInput = lastOutput;
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
    if (cmdArgs[0] === 'sudo') {
      isSudo = true;
      cmdArgs = cmdArgs.slice(1);
      // Handle sudo -l -U username (sudo check)
      if (cmdArgs[0] === '-l') {
        return this.dispatch('sudo', cmdArgs, stdin);
      }
      // Handle sudo -u user cmd
      if (cmdArgs[0] === '-u' && cmdArgs.length >= 3) {
        cmdArgs = cmdArgs.slice(2);
      }
    }

    if (cmdArgs.length === 0) return { output: '', exitCode: 0 };

    const cmd = cmdArgs[0];
    const cmdArgsList = cmdArgs.slice(1);

    let output = '';
    let exitCode = 0;

    try {
      const result = this.dispatch(cmd, cmdArgsList, stdin);
      output = result.output;
      exitCode = result.exitCode;
    } catch (e) {
      output = `${cmd}: error`;
      exitCode = 1;
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

  private dispatch(cmd: string, args: string[], stdin?: string): { output: string; exitCode: number } {
    const c = this.ctx();

    switch (cmd) {
      // File commands
      case 'touch': return { output: cmdTouch(c, args), exitCode: 0 };
      case 'ls': {
        const out = cmdLs(c, args);
        const isErr = out.includes('cannot access');
        return { output: out, exitCode: isErr ? 2 : 0 };
      }
      case 'cat': {
        const out = cmdCat(c, args);
        const isError = out.includes('No such file');
        return { output: out, exitCode: isError ? 1 : 0 };
      }
      case 'echo': return { output: cmdEcho(c, args), exitCode: 0 };
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
        const target = args[0] || '/root';
        const newCwd = this.vfs.normalizePath(target === '-' ? '/root' : target, this.cwd);
        if (this.vfs.getType(newCwd) === 'directory') {
          this.cwd = newCwd;
          return { output: '', exitCode: 0 };
        }
        return { output: `bash: cd: ${target}: No such file or directory`, exitCode: 1 };
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
      case 'useradd': return { output: cmdUseradd(c, args), exitCode: 0 };
      case 'usermod': return { output: cmdUsermod(c, args), exitCode: 0 };
      case 'userdel': return { output: cmdUserdel(c, args), exitCode: 0 };
      case 'passwd': return { output: cmdPasswd(c, args), exitCode: 0 };
      case 'chpasswd': return { output: cmdChpasswd(c, stdin ?? ''), exitCode: 0 };
      case 'chage': return { output: cmdChage(c, args), exitCode: 0 };
      case 'groupadd': return { output: cmdGroupadd(c, args), exitCode: 0 };
      case 'groupmod': return { output: cmdGroupmod(c, args), exitCode: 0 };
      case 'groupdel': return { output: cmdGroupdel(c, args), exitCode: 0 };
      case 'gpasswd': return { output: cmdGpasswd(c, args), exitCode: 0 };
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
      case 'sudo': return { output: cmdSudoCheck(c, args), exitCode: 0 };

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

  /** Get current working directory */
  getCwd(): string { return this.cwd; }
}
