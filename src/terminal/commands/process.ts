import { CommandRegistry } from './index';
import { Process } from '../types';

const mockProcesses: Process[] = [
  { pid: 1, ppid: 0, user: 'root', command: '/sbin/init', state: 'S', cpu: 0.0, mem: 0.1, startTime: new Date(), tty: '?' },
  { pid: 2, ppid: 0, user: 'root', command: '[kthreadd]', state: 'S', cpu: 0.0, mem: 0.0, startTime: new Date(), tty: '?' },
  { pid: 123, ppid: 1, user: 'root', command: '/usr/sbin/sshd -D', state: 'S', cpu: 0.0, mem: 0.2, startTime: new Date(), tty: '?' },
  { pid: 456, ppid: 123, user: 'user', command: 'sshd: user@pts/0', state: 'S', cpu: 0.0, mem: 0.1, startTime: new Date(), tty: 'pts/0' },
  { pid: 789, ppid: 456, user: 'user', command: '-bash', state: 'S', cpu: 0.0, mem: 0.3, startTime: new Date(), tty: 'pts/0' },
  { pid: 1001, ppid: 1, user: 'root', command: '/usr/sbin/cron -f', state: 'S', cpu: 0.0, mem: 0.1, startTime: new Date(), tty: '?' },
  { pid: 1002, ppid: 1, user: 'syslog', command: '/usr/sbin/rsyslogd -n', state: 'S', cpu: 0.0, mem: 0.2, startTime: new Date(), tty: '?' },
  { pid: 1003, ppid: 1, user: 'root', command: '/usr/lib/systemd/systemd-journald', state: 'S', cpu: 0.1, mem: 0.5, startTime: new Date(), tty: '?' },
];

export const processCommands: CommandRegistry = {
  ps: (args, state) => {
    const showAll = args.includes('-e') || args.includes('-A') || args.includes('aux');
    const showFull = args.includes('-f') || args.includes('aux');
    const showUser = args.includes('-u') || args.includes('aux');

    let processes = showAll ? mockProcesses : mockProcesses.filter(p => p.user === state.currentUser || p.tty !== '?');

    if (showFull || showUser) {
      const header = 'USER         PID %CPU %MEM    VSZ   RSS TTY      STAT START   TIME COMMAND';
      const lines = [header];

      processes.forEach(p => {
        const time = p.startTime.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false });
        lines.push(
          `${p.user.padEnd(8)} ${p.pid.toString().padStart(5)} ${p.cpu.toFixed(1).padStart(4)} ${p.mem.toFixed(1).padStart(4)} ` +
          `${(Math.random() * 100000).toFixed(0).padStart(6)} ${(Math.random() * 10000).toFixed(0).padStart(5)} ${p.tty.padEnd(8)} ` +
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
    const now = new Date();
    const time = now.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });

    const lines = [
      `top - ${time} up 5 days,  3:42,  1 user,  load average: 0.15, 0.10, 0.05`,
      `Tasks: ${mockProcesses.length} total,   1 running, ${mockProcesses.length - 1} sleeping,   0 stopped,   0 zombie`,
      `%Cpu(s):  2.3 us,  1.0 sy,  0.0 ni, 96.5 id,  0.2 wa,  0.0 hi,  0.0 si,  0.0 st`,
      `MiB Mem :  16384.0 total,   8192.0 free,   4096.0 used,   4096.0 buff/cache`,
      `MiB Swap:   2048.0 total,   2048.0 free,      0.0 used.  12288.0 avail Mem`,
      ``,
      `    PID USER      PR  NI    VIRT    RES    SHR S  %CPU  %MEM     TIME+ COMMAND`,
    ];

    mockProcesses.slice(0, 15).forEach(p => {
      lines.push(
        `${p.pid.toString().padStart(7)} ${p.user.padEnd(9)} 20   0 ${(Math.random() * 100000).toFixed(0).padStart(7)} ` +
        `${(Math.random() * 10000).toFixed(0).padStart(6)} ${(Math.random() * 5000).toFixed(0).padStart(6)} ${p.state}  ` +
        `${p.cpu.toFixed(1).padStart(4)}  ${p.mem.toFixed(1).padStart(4)} ${' 0:00.00'.padStart(9)} ${p.command.split('/').pop()}`
      );
    });

    return { output: lines.join('\n'), exitCode: 0 };
  },

  htop: (args, state, fs, pm) => {
    if (!pm.isInstalled('htop')) {
      return {
        output: '',
        error: 'Command \'htop\' not found, but can be installed with:\n\nsudo apt install htop',
        exitCode: 127,
      };
    }

    // Return a simplified htop-like output
    return processCommands.top(args, state, fs, pm);
  },

  kill: (args, state) => {
    if (args.length === 0) {
      return { output: '', error: 'kill: usage: kill [-s sigspec | -n signum | -sigspec] pid | jobspec ... or kill -l [sigspec]', exitCode: 1 };
    }

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
        pids.push(parseInt(arg));
      }
    }

    for (const pid of pids) {
      const process = mockProcesses.find(p => p.pid === pid);
      if (!process) {
        return { output: '', error: `kill: (${pid}) - No such process`, exitCode: 1 };
      }

      if (process.user !== state.currentUser && state.currentUser !== 'root') {
        return { output: '', error: `kill: (${pid}) - Operation not permitted`, exitCode: 1 };
      }
    }

    return { output: '', exitCode: 0 };
  },

  killall: (args, state) => {
    if (args.length === 0) {
      return { output: '', error: 'killall: no process name specified', exitCode: 1 };
    }

    const processName = args.filter(a => !a.startsWith('-'))[0];
    const found = mockProcesses.filter(p => p.command.includes(processName));

    if (found.length === 0) {
      return { output: '', error: `${processName}: no process found`, exitCode: 1 };
    }

    return { output: '', exitCode: 0 };
  },

  pkill: (args) => {
    if (args.length === 0) {
      return { output: '', error: 'pkill: no matching pattern specified', exitCode: 1 };
    }

    return { output: '', exitCode: 0 };
  },

  pgrep: (args) => {
    if (args.length === 0) {
      return { output: '', error: 'pgrep: no matching pattern specified', exitCode: 1 };
    }

    const pattern = args.filter(a => !a.startsWith('-'))[0];
    const matches = mockProcesses.filter(p => p.command.includes(pattern));

    if (matches.length === 0) {
      return { output: '', exitCode: 1 };
    }

    return { output: matches.map(p => p.pid.toString()).join('\n'), exitCode: 0 };
  },

  jobs: () => ({
    output: '',
    exitCode: 0,
  }),

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
    if (state.currentUser !== 'root') {
      return { output: '', error: 'renice: failed to set priority: Permission denied', exitCode: 1 };
    }
    return { output: '', exitCode: 0 };
  },

  time: (args) => {
    if (args.length === 0) {
      return { output: '', error: 'Usage: time [command [arg ...]]', exitCode: 0 };
    }

    return {
      output: `\nreal\t0m0.001s\nuser\t0m0.001s\nsys\t0m0.000s`,
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
    if (state.currentUser !== 'root' && !args.includes('-u')) {
      return {
        output: 'COMMAND     PID   TID TASKCMD       USER   FD      TYPE DEVICE SIZE/OFF NODE NAME\nbash        789             user   cwd       DIR  254,1     4096    1 /home/user',
        exitCode: 0,
      };
    }

    const lines = [
      'COMMAND     PID   TID TASKCMD       USER   FD      TYPE DEVICE SIZE/OFF NODE NAME',
      'systemd       1                     root  cwd       DIR  254,1     4096    2 /',
      'sshd        123                     root  cwd       DIR  254,1     4096    2 /',
      'bash        789                     user  cwd       DIR  254,1     4096    1 /home/user',
    ];

    return { output: lines.join('\n'), exitCode: 0 };
  },

  fuser: (args) => {
    if (args.length === 0) {
      return { output: '', error: 'No process specification given', exitCode: 1 };
    }

    return { output: `${args[0]}:                 789`, exitCode: 0 };
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
};
