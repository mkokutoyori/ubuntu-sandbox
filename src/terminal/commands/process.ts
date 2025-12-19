import { CommandRegistry } from './index';
import { getProcessManager } from '../processManager';

export const processCommands: CommandRegistry = {
  ps: (args, state) => {
    const pm = getProcessManager();
    const showAll = args.includes('-e') || args.includes('-A') || args.includes('aux');
    const showFull = args.includes('-f') || args.includes('aux');
    const showUser = args.includes('-u') || args.includes('aux');

    let processes = showAll
      ? pm.getAll()
      : pm.getAll().filter(p => p.user === state.currentUser || p.tty !== '?');

    if (showFull || showUser) {
      const header = 'USER         PID %CPU %MEM    VSZ   RSS TTY      STAT START   TIME COMMAND';
      const lines = [header];

      processes.forEach(p => {
        const time = p.startTime.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false });
        const vsz = Math.floor(Math.random() * 100000 + 10000);
        const rss = Math.floor(vsz * 0.3);
        lines.push(
          `${p.user.padEnd(8)} ${p.pid.toString().padStart(5)} ${p.cpu.toFixed(1).padStart(4)} ${p.mem.toFixed(1).padStart(4)} ` +
          `${vsz.toString().padStart(6)} ${rss.toString().padStart(5)} ${p.tty.padEnd(8)} ` +
          `${p.state.padEnd(4)} ${time} ${'0:00'.padStart(5)} ${p.command}`
        );
      });

      return { output: lines.join('\n'), exitCode: 0 };
    }

    const header = '  PID TTY          TIME CMD';
    const lines = [header];

    processes.filter(p => p.tty !== '?').forEach(p => {
      lines.push(`${p.pid.toString().padStart(5)} ${p.tty.padEnd(8)} ${'00:00:00'.padStart(8)} ${p.command.split(' ')[0]}`);
    });

    return { output: lines.join('\n'), exitCode: 0 };
  },

  top: (args, state) => {
    const pm = getProcessManager();
    const now = new Date();
    const time = now.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
    const uptime = pm.getUptime();
    const stats = pm.getProcessStats();
    const load = pm.getLoadAverage();
    const processes = pm.getAll();

    const lines = [
      `top - ${time} up ${uptime.days} days, ${uptime.hours}:${uptime.minutes.toString().padStart(2, '0')},  1 user,  load average: ${load[0].toFixed(2)}, ${load[1].toFixed(2)}, ${load[2].toFixed(2)}`,
      `Tasks: ${stats.total} total,   ${stats.running} running, ${stats.sleeping} sleeping,   ${stats.stopped} stopped,   ${stats.zombie} zombie`,
      `%Cpu(s):  ${(2 + Math.random() * 3).toFixed(1)} us,  ${(0.5 + Math.random()).toFixed(1)} sy,  0.0 ni, ${(94 + Math.random() * 3).toFixed(1)} id,  0.2 wa,  0.0 hi,  0.0 si,  0.0 st`,
      `MiB Mem :  16384.0 total,   ${(8000 + Math.random() * 2000).toFixed(1)} free,   ${(3000 + Math.random() * 2000).toFixed(1)} used,   ${(4000 + Math.random() * 1000).toFixed(1)} buff/cache`,
      `MiB Swap:   2048.0 total,   2048.0 free,      0.0 used.  ${(12000 + Math.random() * 1000).toFixed(1)} avail Mem`,
      ``,
      `    PID USER      PR  NI    VIRT    RES    SHR S  %CPU  %MEM     TIME+ COMMAND`,
    ];

    // Sort by CPU usage for top
    const sorted = [...processes].sort((a, b) => b.cpu - a.cpu).slice(0, 15);

    sorted.forEach(p => {
      const virt = Math.floor(Math.random() * 100000 + 10000);
      const res = Math.floor(virt * 0.3);
      const shr = Math.floor(res * 0.5);
      lines.push(
        `${p.pid.toString().padStart(7)} ${p.user.padEnd(9)} 20   0 ${virt.toString().padStart(7)} ` +
        `${res.toString().padStart(6)} ${shr.toString().padStart(6)} ${p.state}  ` +
        `${p.cpu.toFixed(1).padStart(4)}  ${p.mem.toFixed(1).padStart(4)} ${' 0:00.00'.padStart(9)} ${p.command.split('/').pop()?.split(' ')[0] || p.command}`
      );
    });

    return { output: lines.join('\n'), exitCode: 0 };
  },

  htop: (args, state, fs, pkgMgr) => {
    if (!pkgMgr.isInstalled('htop')) {
      return {
        output: '',
        error: 'Command \'htop\' not found, but can be installed with:\n\nsudo apt install htop',
        exitCode: 127,
      };
    }

    // Return a simplified htop-like output
    return processCommands.top(args, state, fs, pkgMgr);
  },

  kill: (args, state) => {
    if (args.length === 0) {
      return { output: '', error: 'kill: usage: kill [-s sigspec | -n signum | -sigspec] pid | jobspec ... or kill -l [sigspec]', exitCode: 1 };
    }

    const pm = getProcessManager();
    let signal = 'TERM';
    const pids: number[] = [];

    for (const arg of args) {
      if (arg === '-9' || arg === '-KILL') {
        signal = 'KILL';
      } else if (arg === '-15' || arg === '-TERM') {
        signal = 'TERM';
      } else if (arg === '-l') {
        return {
          output: ' 1) SIGHUP\t 2) SIGINT\t 3) SIGQUIT\t 4) SIGILL\t 5) SIGTRAP\n' +
                  ' 6) SIGABRT\t 7) SIGBUS\t 8) SIGFPE\t 9) SIGKILL\t10) SIGUSR1\n' +
                  '11) SIGSEGV\t12) SIGUSR2\t13) SIGPIPE\t14) SIGALRM\t15) SIGTERM',
          exitCode: 0,
        };
      } else if (!arg.startsWith('-')) {
        const pid = parseInt(arg);
        if (isNaN(pid)) {
          return { output: '', error: `kill: ${arg}: arguments must be process or job IDs`, exitCode: 1 };
        }
        pids.push(pid);
      }
    }

    if (pids.length === 0) {
      return { output: '', error: 'kill: usage: kill [-s sigspec | -n signum | -sigspec] pid | jobspec ... or kill -l [sigspec]', exitCode: 1 };
    }

    const errors: string[] = [];
    for (const pid of pids) {
      const result = pm.kill(pid, state.currentUser, state.isRoot);
      if (!result.success) {
        errors.push(`kill: ${result.error}`);
      }
    }

    if (errors.length > 0) {
      return { output: '', error: errors.join('\n'), exitCode: 1 };
    }

    return { output: '', exitCode: 0 };
  },

  killall: (args, state) => {
    if (args.length === 0) {
      return { output: '', error: 'killall: no process name specified', exitCode: 1 };
    }

    const pm = getProcessManager();
    const processName = args.filter(a => !a.startsWith('-'))[0];
    const result = pm.killByName(processName, state.currentUser, state.isRoot);

    if (result.error) {
      return { output: '', error: result.error, exitCode: 1 };
    }

    return { output: '', exitCode: 0 };
  },

  pkill: (args, state) => {
    if (args.length === 0) {
      return { output: '', error: 'pkill: no matching pattern specified', exitCode: 1 };
    }

    const pm = getProcessManager();
    const pattern = args.filter(a => !a.startsWith('-'))[0];
    const result = pm.killByName(pattern, state.currentUser, state.isRoot);

    return { output: '', exitCode: result.killed > 0 ? 0 : 1 };
  },

  pgrep: (args) => {
    if (args.length === 0) {
      return { output: '', error: 'pgrep: no matching pattern specified', exitCode: 1 };
    }

    const pm = getProcessManager();
    const showFull = args.includes('-f');
    const showList = args.includes('-l');
    const pattern = args.filter(a => !a.startsWith('-'))[0];
    const matches = pm.findByPattern(pattern);

    if (matches.length === 0) {
      return { output: '', exitCode: 1 };
    }

    if (showFull || showList) {
      return {
        output: matches.map(p => `${p.pid} ${p.command}`).join('\n'),
        exitCode: 0
      };
    }

    return { output: matches.map(p => p.pid.toString()).join('\n'), exitCode: 0 };
  },

  jobs: (args, state) => {
    const pm = getProcessManager();
    // In this simulation, background jobs are processes spawned by the shell
    const bgJobs = pm.getByTty('pts/0').filter(p =>
      p.ppid === pm.getShellPid() && p.state === 'T'
    );

    if (bgJobs.length === 0) {
      return { output: '', exitCode: 0 };
    }

    const lines = bgJobs.map((job, i) =>
      `[${i + 1}]${i === bgJobs.length - 1 ? '+' : '-'}  Stopped                 ${job.command}`
    );

    return { output: lines.join('\n'), exitCode: 0 };
  },

  bg: () => ({
    output: 'bash: bg: no current job',
    exitCode: 1,
  }),

  fg: () => ({
    output: 'bash: fg: no current job',
    exitCode: 1,
  }),

  nohup: (args) => {
    if (args.length === 0) {
      return { output: '', error: 'nohup: missing operand', exitCode: 125 };
    }
    return { output: 'nohup: ignoring input and appending output to \'nohup.out\'', exitCode: 0 };
  },

  nice: (args) => {
    if (args.length === 0) {
      return { output: '0', exitCode: 0 };
    }
    return { output: '', exitCode: 0 };
  },

  renice: (args, state) => {
    if (args.length < 2) {
      return { output: '', error: 'renice: missing operand', exitCode: 1 };
    }
    if (state.currentUser !== 'root') {
      return { output: '', error: 'renice: failed to set priority: Permission denied', exitCode: 1 };
    }
    return { output: '', exitCode: 0 };
  },

  time: (args) => {
    if (args.length === 0) {
      return { output: '', error: 'Usage: time [command [arg ...]]', exitCode: 0 };
    }

    const real = (Math.random() * 0.1).toFixed(3);
    const user = (Math.random() * 0.05).toFixed(3);
    const sys = (Math.random() * 0.02).toFixed(3);

    return {
      output: `\nreal\t0m${real}s\nuser\t0m${user}s\nsys\t0m${sys}s`,
      exitCode: 0,
    };
  },

  watch: (args) => {
    if (args.length === 0) {
      return { output: '', error: 'Usage: watch [-bdehpvtx] [-n <seconds>] [--] <command>', exitCode: 1 };
    }

    return { output: '[watch: would execute command repeatedly]', exitCode: 0 };
  },

  timeout: (args) => {
    if (args.length < 2) {
      return { output: '', error: 'timeout: missing operand', exitCode: 125 };
    }
    return { output: '', exitCode: 0 };
  },

  lsof: (args, state) => {
    const pm = getProcessManager();
    const processes = pm.getAll();

    const header = 'COMMAND     PID   TID TASKCMD       USER   FD      TYPE DEVICE SIZE/OFF NODE NAME';
    const lines = [header];

    const relevantProcs = state.currentUser === 'root' || args.includes('-u')
      ? processes.slice(0, 10)
      : processes.filter(p => p.user === state.currentUser);

    relevantProcs.forEach(p => {
      const cmdName = p.command.split('/').pop()?.split(' ')[0]?.substring(0, 9) || 'unknown';
      lines.push(
        `${cmdName.padEnd(9)} ${p.pid.toString().padStart(5)}                   ${p.user.padEnd(6)} cwd       DIR  254,1     4096    ${Math.floor(Math.random() * 1000)} ${p.tty === '?' ? '/' : '/home/' + p.user}`
      );
    });

    return { output: lines.join('\n'), exitCode: 0 };
  },

  fuser: (args) => {
    if (args.length === 0) {
      return { output: '', error: 'No process specification given', exitCode: 1 };
    }

    const pm = getProcessManager();
    const shellPid = pm.getShellPid();

    return { output: `${args[0]}:                 ${shellPid}`, exitCode: 0 };
  },

  strace: (args, state) => {
    if (state.currentUser !== 'root') {
      return { output: '', error: 'strace: permission denied', exitCode: 1 };
    }

    if (args.length === 0) {
      return { output: '', error: 'strace: must have PROG [ARGS] or -p PID', exitCode: 1 };
    }

    return {
      output: `execve("${args[0]}", ["${args.join('", "')}"], 0x7ffd...) = 0
brk(NULL)                               = 0x55555555a000
access("/etc/ld.so.preload", R_OK)      = -1 ENOENT
openat(AT_FDCWD, "/etc/ld.so.cache", O_RDONLY|O_CLOEXEC) = 3
...
exit_group(0)                           = ?
+++ exited with 0 +++`,
      exitCode: 0,
    };
  },

  uptime: () => {
    const pm = getProcessManager();
    const now = new Date();
    const time = now.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
    const uptime = pm.getUptime();
    const load = pm.getLoadAverage();

    return {
      output: ` ${time} up ${uptime.days} days, ${uptime.hours}:${uptime.minutes.toString().padStart(2, '0')},  1 user,  load average: ${load[0].toFixed(2)}, ${load[1].toFixed(2)}, ${load[2].toFixed(2)}`,
      exitCode: 0,
    };
  },

  free: (args) => {
    const human = args.includes('-h');
    const wide = args.includes('-w');

    const total = 16384;
    const used = 3500 + Math.floor(Math.random() * 500);
    const free = 8000 + Math.floor(Math.random() * 1000);
    const shared = 512;
    const buffCache = total - used - free;
    const available = free + buffCache - 500;

    const swapTotal = 2048;
    const swapUsed = 0;
    const swapFree = swapTotal;

    const format = (val: number) => {
      if (human) {
        if (val >= 1024) return `${(val / 1024).toFixed(1)}Gi`;
        return `${val}Mi`;
      }
      return (val * 1024).toString().padStart(10);
    };

    if (human) {
      return {
        output: `               total        used        free      shared  buff/cache   available
Mem:           ${format(total)}     ${format(used)}     ${format(free)}      ${format(shared)}     ${format(buffCache)}     ${format(available)}
Swap:          ${format(swapTotal)}          ${format(swapUsed)}     ${format(swapFree)}`,
        exitCode: 0,
      };
    }

    return {
      output: `              total        used        free      shared  buff/cache   available
Mem:       ${format(total)} ${format(used)} ${format(free)}   ${format(shared)}  ${format(buffCache)}  ${format(available)}
Swap:      ${format(swapTotal)}       ${format(swapUsed)} ${format(swapFree)}`,
      exitCode: 0,
    };
  },

  vmstat: (args) => {
    const interval = args.length > 0 ? parseInt(args[0]) || 1 : 1;
    const count = args.length > 1 ? parseInt(args[1]) || 1 : 1;

    const lines = [
      'procs -----------memory---------- ---swap-- -----io---- -system-- ------cpu-----',
      ' r  b   swpd   free   buff  cache   si   so    bi    bo   in   cs us sy id wa st',
    ];

    for (let i = 0; i < Math.min(count, 5); i++) {
      const r = Math.floor(Math.random() * 3);
      const b = 0;
      const swpd = 0;
      const free = 8000000 + Math.floor(Math.random() * 1000000);
      const buff = 200000 + Math.floor(Math.random() * 100000);
      const cache = 4000000 + Math.floor(Math.random() * 500000);

      lines.push(
        ` ${r}  ${b}      ${swpd} ${free.toString().padStart(7)} ${buff.toString().padStart(6)} ${cache.toString().padStart(6)}    0    0     ${Math.floor(Math.random() * 100)}     ${Math.floor(Math.random() * 50)}  ${100 + Math.floor(Math.random() * 50)}  ${200 + Math.floor(Math.random() * 100)}  ${Math.floor(Math.random() * 5)}  ${Math.floor(Math.random() * 2)} ${95 + Math.floor(Math.random() * 4)}  0  0`
      );
    }

    return { output: lines.join('\n'), exitCode: 0 };
  },
};
