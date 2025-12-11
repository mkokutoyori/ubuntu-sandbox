import { CommandRegistry } from './index';

export const systemCommands: CommandRegistry = {
  clear: () => ({
    output: '',
    exitCode: 0,
    clearScreen: true,
  }),

  echo: (args) => {
    let noNewline = false;
    let interpretEscapes = false;
    const textParts: string[] = [];

    for (const arg of args) {
      if (arg === '-n') {
        noNewline = true;
      } else if (arg === '-e') {
        interpretEscapes = true;
      } else {
        textParts.push(arg);
      }
    }

    let output = textParts.join(' ');

    if (interpretEscapes) {
      output = output
        .replace(/\\n/g, '\n')
        .replace(/\\t/g, '\t')
        .replace(/\\r/g, '\r')
        .replace(/\\\\/g, '\\');
    }

    return { output: noNewline ? output : output, exitCode: 0 };
  },

  date: (args) => {
    const now = new Date();

    if (args.length > 0 && args[0].startsWith('+')) {
      const format = args[0].substring(1);
      let output = format;

      const replacements: { [key: string]: string } = {
        '%Y': now.getFullYear().toString(),
        '%m': (now.getMonth() + 1).toString().padStart(2, '0'),
        '%d': now.getDate().toString().padStart(2, '0'),
        '%H': now.getHours().toString().padStart(2, '0'),
        '%M': now.getMinutes().toString().padStart(2, '0'),
        '%S': now.getSeconds().toString().padStart(2, '0'),
        '%A': now.toLocaleDateString('en-US', { weekday: 'long' }),
        '%B': now.toLocaleDateString('en-US', { month: 'long' }),
        '%Z': Intl.DateTimeFormat().resolvedOptions().timeZone,
      };

      for (const [key, value] of Object.entries(replacements)) {
        output = output.replace(new RegExp(key, 'g'), value);
      }

      return { output, exitCode: 0 };
    }

    return {
      output: now.toString(),
      exitCode: 0,
    };
  },

  cal: (args) => {
    const now = new Date();
    let year = now.getFullYear();
    let month = now.getMonth();

    if (args.length === 1) {
      year = parseInt(args[0]) || year;
      month = -1; // Show whole year
    } else if (args.length === 2) {
      month = parseInt(args[0]) - 1;
      year = parseInt(args[1]) || year;
    }

    if (month === -1) {
      return { output: generateYearCalendar(year), exitCode: 0 };
    }

    return { output: generateMonthCalendar(year, month, now), exitCode: 0 };
  },

  uptime: () => {
    const uptimeSeconds = Math.floor(Math.random() * 86400 * 30);
    const days = Math.floor(uptimeSeconds / 86400);
    const hours = Math.floor((uptimeSeconds % 86400) / 3600);
    const minutes = Math.floor((uptimeSeconds % 3600) / 60);

    const now = new Date();
    const time = now.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false });

    let uptimeStr = '';
    if (days > 0) {
      uptimeStr = `${days} days, ${hours}:${minutes.toString().padStart(2, '0')}`;
    } else {
      uptimeStr = `${hours}:${minutes.toString().padStart(2, '0')}`;
    }

    return {
      output: ` ${time} up ${uptimeStr},  1 user,  load average: 0.15, 0.10, 0.05`,
      exitCode: 0,
    };
  },

  uname: (args) => {
    const info = {
      s: 'Linux',
      n: 'ubuntu-terminal',
      r: '5.15.0-generic',
      v: '#1 SMP PREEMPT_DYNAMIC',
      m: 'x86_64',
      p: 'x86_64',
      i: 'x86_64',
      o: 'GNU/Linux',
    };

    if (args.length === 0 || args.includes('-s')) {
      return { output: info.s, exitCode: 0 };
    }

    if (args.includes('-a')) {
      return {
        output: `${info.s} ${info.n} ${info.r} ${info.v} ${info.m} ${info.p} ${info.i} ${info.o}`,
        exitCode: 0,
      };
    }

    const parts: string[] = [];
    if (args.includes('-s')) parts.push(info.s);
    if (args.includes('-n')) parts.push(info.n);
    if (args.includes('-r')) parts.push(info.r);
    if (args.includes('-v')) parts.push(info.v);
    if (args.includes('-m')) parts.push(info.m);
    if (args.includes('-p')) parts.push(info.p);
    if (args.includes('-i')) parts.push(info.i);
    if (args.includes('-o')) parts.push(info.o);

    return { output: parts.join(' ') || info.s, exitCode: 0 };
  },

  hostname: (args, state, fs) => {
    if (args.length === 0) {
      return { output: state.hostname, exitCode: 0 };
    }
    return { output: '', exitCode: 0 };
  },

  whoami: (args, state) => ({
    output: state.currentUser,
    exitCode: 0,
  }),

  id: (args, state, fs) => {
    const username = args[0] || state.currentUser;
    const user = fs.getUser(username);

    if (!user) {
      return { output: '', error: `id: '${username}': no such user`, exitCode: 1 };
    }

    const groups = user.groups.map((g, i) => {
      const group = fs.groups.get(g);
      return `${group?.gid || i}(${g})`;
    }).join(',');

    return {
      output: `uid=${user.uid}(${user.username}) gid=${user.gid}(${user.groups[0]}) groups=${groups}`,
      exitCode: 0,
    };
  },

  env: (args, state) => {
    if (args.length === 0) {
      const lines = Object.entries(state.env)
        .map(([key, value]) => `${key}=${value}`);
      return { output: lines.join('\n'), exitCode: 0 };
    }
    return { output: '', exitCode: 0 };
  },

  export: (args, state) => {
    if (args.length === 0) {
      const lines = Object.entries(state.env)
        .map(([key, value]) => `declare -x ${key}="${value}"`);
      return { output: lines.join('\n'), exitCode: 0 };
    }

    for (const arg of args) {
      if (arg.includes('=')) {
        const [key, ...valueParts] = arg.split('=');
        state.env[key] = valueParts.join('=');
      }
    }

    return { output: '', exitCode: 0 };
  },

  alias: (args, state) => {
    if (args.length === 0) {
      const lines = Object.entries(state.aliases)
        .map(([key, value]) => `alias ${key}='${value}'`);
      return { output: lines.join('\n'), exitCode: 0 };
    }

    for (const arg of args) {
      if (arg.includes('=')) {
        const [key, ...valueParts] = arg.split('=');
        let value = valueParts.join('=');
        if ((value.startsWith("'") && value.endsWith("'")) ||
            (value.startsWith('"') && value.endsWith('"'))) {
          value = value.slice(1, -1);
        }
        state.aliases[key] = value;
      }
    }

    return { output: '', exitCode: 0 };
  },

  unalias: (args, state) => {
    for (const arg of args) {
      delete state.aliases[arg];
    }
    return { output: '', exitCode: 0 };
  },

  which: (args, state, fs) => {
    if (args.length === 0) {
      return { output: '', exitCode: 1 };
    }

    const results: string[] = [];
    for (const cmd of args) {
      const paths = ['/bin', '/usr/bin', '/sbin', '/usr/sbin'];
      let found = false;

      for (const p of paths) {
        const fullPath = `${p}/${cmd}`;
        if (fs.getNode(fullPath)) {
          results.push(fullPath);
          found = true;
          break;
        }
      }

      if (!found) {
        return { output: '', error: `${cmd} not found`, exitCode: 1 };
      }
    }

    return { output: results.join('\n'), exitCode: 0 };
  },

  whereis: (args, state, fs) => {
    if (args.length === 0) {
      return { output: '', exitCode: 0 };
    }

    const results: string[] = [];
    for (const cmd of args) {
      const binPaths = ['/bin', '/usr/bin', '/sbin', '/usr/sbin'];
      const found: string[] = [];

      for (const p of binPaths) {
        const fullPath = `${p}/${cmd}`;
        if (fs.getNode(fullPath)) {
          found.push(fullPath);
        }
      }

      results.push(`${cmd}: ${found.join(' ')}`);
    }

    return { output: results.join('\n'), exitCode: 0 };
  },

  history: (args, state) => {
    const lines = state.history.map((cmd, i) => `  ${(i + 1).toString().padStart(4)}  ${cmd}`);
    return { output: lines.join('\n'), exitCode: 0 };
  },

  exit: () => ({
    output: 'logout',
    exitCode: 0,
  }),

  reboot: (args, state) => {
    if (state.currentUser !== 'root') {
      return { output: '', error: 'reboot: must be superuser.', exitCode: 1 };
    }
    return { output: 'System is going down for reboot NOW!', exitCode: 0 };
  },

  shutdown: (args, state) => {
    if (state.currentUser !== 'root') {
      return { output: '', error: 'shutdown: must be superuser.', exitCode: 1 };
    }
    return { output: 'System is going down for poweroff NOW!', exitCode: 0 };
  },

  df: (args) => {
    const humanReadable = args.includes('-h');
    const header = 'Filesystem      Size  Used Avail Use% Mounted on';
    const lines = [
      header,
      `/dev/sda1       ${humanReadable ? '50G' : '52428800'}   ${humanReadable ? '15G' : '15728640'}   ${humanReadable ? '33G' : '34603008'}  31% /`,
      `tmpfs           ${humanReadable ? '7.8G' : '8175616'}   ${humanReadable ? '0' : '0'}    ${humanReadable ? '7.8G' : '8175616'}   0% /dev/shm`,
      `tmpfs           ${humanReadable ? '1.6G' : '1671168'}   ${humanReadable ? '10M' : '10240'}   ${humanReadable ? '1.6G' : '1660928'}   1% /run`,
    ];
    return { output: lines.join('\n'), exitCode: 0 };
  },

  du: (args, state, fs) => {
    let humanReadable = false;
    let summarize = false;
    let targetPath = state.currentPath;

    for (const arg of args) {
      if (arg === '-h') humanReadable = true;
      else if (arg === '-s') summarize = true;
      else if (!arg.startsWith('-')) targetPath = fs.resolvePath(arg, state.currentPath);
    }

    const node = fs.getNode(targetPath);
    if (!node) {
      return { output: '', error: `du: cannot access '${targetPath}': No such file or directory`, exitCode: 1 };
    }

    const size = humanReadable ? '4.0K' : '4';
    
    if (summarize) {
      return { output: `${size}\t${targetPath}`, exitCode: 0 };
    }

    const lines: string[] = [];
    if (node.type === 'directory' && node.children) {
      node.children.forEach((child, name) => {
        lines.push(`${size}\t${targetPath}/${name}`);
      });
    }
    lines.push(`${size}\t${targetPath}`);

    return { output: lines.join('\n'), exitCode: 0 };
  },

  free: (args) => {
    const humanReadable = args.includes('-h');
    const header = '               total        used        free      shared  buff/cache   available';
    
    if (humanReadable) {
      return {
        output: [
          header,
          'Mem:            16Gi       4.2Gi       8.1Gi       512Mi       3.7Gi        11Gi',
          'Swap:          2.0Gi          0B       2.0Gi',
        ].join('\n'),
        exitCode: 0,
      };
    }

    return {
      output: [
        header,
        'Mem:        16777216     4404019     8493465      524288     3879732    11846912',
        'Swap:        2097152           0     2097152',
      ].join('\n'),
      exitCode: 0,
    };
  },

  lsb_release: (args) => {
    if (args.includes('-a')) {
      return {
        output: [
          'Distributor ID: Ubuntu',
          'Description:    Ubuntu 22.04.3 LTS',
          'Release:        22.04',
          'Codename:       jammy',
        ].join('\n'),
        exitCode: 0,
      };
    }
    return { output: 'Ubuntu 22.04.3 LTS', exitCode: 0 };
  },

  neofetch: (args, state, fs, pm) => {
    if (!pm.isInstalled('neofetch')) {
      return { output: '', error: 'Command \'neofetch\' not found, but can be installed with:\n\nsudo apt install neofetch', exitCode: 127 };
    }

    const logo = [
      '             .-/+oossssoo+/-.',
      '         `:+ssssssssssssssssss+:`',
      '       -+ssssssssssssssssssyyssss+-',
      '     .ossssssssssssssssssdMMMNysssso.',
      '   /ssssssssssshdmmNNmmyNMMMMhssssss/',
      '  +ssssssssshmydMMMMMMMNddddyssssssss+',
      ' /sssssssshNMMMyhhyyyyhmNMMMNhssssssss/',
      '.ssssssssdMMMNhsssssssssshNMMMdssssssss.',
      '+sssshhhyNMMNyssssssssssssyNMMMysssssss+',
      'ossyNMMMNyMMhsssssssssssssshmmmhssssssso',
      'ossyNMMMNyMMhsssssssssssssshmmmhssssssso',
      '+sssshhhyNMMNyssssssssssssyNMMMysssssss+',
      '.ssssssssdMMMNhsssssssssshNMMMdssssssss.',
      ' /sssssssshNMMMyhhyyyyhdNMMMNhssssssss/',
      '  +sssssssssdmydMMMMMMMMddddyssssssss+',
      '   /ssssssssssshdmNNNNmyNMMMMhssssss/',
      '    .ossssssssssssssssssdMMMNysssso.',
      '      -+sssssssssssssssssyyyssss+-',
      '        `:+ssssssssssssssssss+:`',
      '            .-/+oossssoo+/-.',
    ];

    const user = fs.getUser(state.currentUser);
    const info = [
      `\x1b[1;31m${state.currentUser}@${state.hostname}\x1b[0m`,
      '----------------------',
      `\x1b[1;31mOS:\x1b[0m Ubuntu 22.04.3 LTS x86_64`,
      `\x1b[1;31mHost:\x1b[0m Virtual Terminal`,
      `\x1b[1;31mKernel:\x1b[0m 5.15.0-generic`,
      `\x1b[1;31mUptime:\x1b[0m ${Math.floor(Math.random() * 30)} days`,
      `\x1b[1;31mPackages:\x1b[0m 1523 (dpkg)`,
      `\x1b[1;31mShell:\x1b[0m ${user?.shell || '/bin/bash'}`,
      `\x1b[1;31mTerminal:\x1b[0m /dev/pts/0`,
      `\x1b[1;31mCPU:\x1b[0m Intel i7-8565U @ 1.80GHz`,
      `\x1b[1;31mMemory:\x1b[0m 4201MiB / 16384MiB`,
      '',
      '\x1b[40m  \x1b[41m  \x1b[42m  \x1b[43m  \x1b[44m  \x1b[45m  \x1b[46m  \x1b[47m  \x1b[0m',
    ];

    const output: string[] = [];
    for (let i = 0; i < Math.max(logo.length, info.length); i++) {
      const logoLine = logo[i] || '                      ';
      const infoLine = info[i] || '';
      output.push(`\x1b[1;33m${logoLine}\x1b[0m    ${infoLine}`);
    }

    return { output: output.join('\n'), exitCode: 0 };
  },

  sleep: (args) => {
    const seconds = parseInt(args[0]) || 1;
    return { output: '', exitCode: 0 };
  },

  true: () => ({ output: '', exitCode: 0 }),
  false: () => ({ output: '', exitCode: 1 }),

  yes: (args) => {
    const text = args.length > 0 ? args.join(' ') : 'y';
    return { output: Array(20).fill(text).join('\n'), exitCode: 0 };
  },

  printenv: (args, state) => {
    if (args.length === 0) {
      const lines = Object.entries(state.env)
        .map(([key, value]) => `${key}=${value}`);
      return { output: lines.join('\n'), exitCode: 0 };
    }

    const value = state.env[args[0]];
    return { output: value || '', exitCode: value ? 0 : 1 };
  },
};

function generateMonthCalendar(year: number, month: number, today: Date): string {
  const firstDay = new Date(year, month, 1);
  const lastDay = new Date(year, month + 1, 0);
  const monthName = firstDay.toLocaleDateString('en-US', { month: 'long' });

  const header = `     ${monthName} ${year}`;
  const days = 'Su Mo Tu We Th Fr Sa';

  let cal = [header, days];
  let week = '   '.repeat(firstDay.getDay());

  for (let day = 1; day <= lastDay.getDate(); day++) {
    const isToday = year === today.getFullYear() && month === today.getMonth() && day === today.getDate();
    const dayStr = day.toString().padStart(2, ' ');
    week += isToday ? `\x1b[7m${dayStr}\x1b[0m ` : `${dayStr} `;

    if ((firstDay.getDay() + day) % 7 === 0 || day === lastDay.getDate()) {
      cal.push(week.trimEnd());
      week = '';
    }
  }

  return cal.join('\n');
}

function generateYearCalendar(year: number): string {
  const lines: string[] = [`                            ${year}`, ''];
  
  for (let row = 0; row < 4; row++) {
    const months = [row * 3, row * 3 + 1, row * 3 + 2];
    const calendars = months.map(m => {
      const date = new Date(year, m, 1);
      return {
        name: date.toLocaleDateString('en-US', { month: 'long' }),
        cal: generateMonthCalendar(year, m, new Date(0)).split('\n'),
      };
    });

    // Header row
    lines.push(calendars.map(c => c.name.padStart(10 + c.name.length / 2).padEnd(22)).join(''));
    
    // Days header
    lines.push(calendars.map(() => 'Su Mo Tu We Th Fr Sa').join('  '));

    // Calendar rows
    const maxRows = Math.max(...calendars.map(c => c.cal.length - 2));
    for (let i = 0; i < maxRows; i++) {
      lines.push(calendars.map(c => (c.cal[i + 2] || '').padEnd(20)).join('  '));
    }

    lines.push('');
  }

  return lines.join('\n');
}
