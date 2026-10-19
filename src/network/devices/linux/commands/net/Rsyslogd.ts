import type { LinuxCommand } from '../LinuxCommand';
import type { LinuxCommandContext } from '../LinuxCommandContext';
import { makeArgCompleter } from '../completionHelpers';
import { RSYSLOG_VERSION } from '@/network/rsyslog/engine/Log';
import { RSYSLOG_CONFIG_PATH, type LinuxRsyslogDaemon } from '../../syslog/LinuxRsyslogDaemon';

const RSYSLOGD_BINARY = '/usr/sbin/rsyslogd';
const PID_FILE = '/run/rsyslogd.pid';

interface WithRsyslog {
  rsyslogDaemon?: LinuxRsyslogDaemon | null;
}

function daemon(ctx: LinuxCommandContext): LinuxRsyslogDaemon | null {
  return (ctx.executor as unknown as WithRsyslog).rsyslogDaemon ?? null;
}

function versionText(): string {
  return [
    `rsyslogd  ${RSYSLOG_VERSION} (aka 2021.12) compiled with:`,
    '\tPLATFORM:\t\t\t\tx86_64-pc-linux-gnu',
    '\tPLATFORM (lsb_release -d):\t\t',
    '\tFEATURE_REGEXP:\t\t\t\tYes',
    '\tGSSAPI Kerberos 5 support:\t\tYes',
    '\tFEATURE_DEBUG (debug build, slow code):\tNo',
    '\t32bit Atomic operations supported:\tYes',
    '\t64bit Atomic operations supported:\tYes',
    '\tmemory allocator:\t\t\tsystem default',
    '\tRuntime Instrumentation (slow code):\tNo',
    '\tuuid support:\t\t\t\tYes',
    '\tsystemd support:\t\t\tYes',
    '\tConfig file:\t\t\t\t/etc/rsyslog.conf',
    `\tPID file:\t\t\t\t${PID_FILE}`,
    '\tNumber of Bits in RainerScript integers: 64',
    '',
    'See https://www.rsyslog.com for more information.',
  ].join('\n');
}

export const rsyslogdCommand: LinuxCommand = {
  name: 'rsyslogd',
  package: 'rsyslog',
  needsNetworkContext: true,
  binaryPath: RSYSLOGD_BINARY,
  complete: makeArgCompleter({ flags: ['-N', '-n', '-v', '-f', '-d'] }),
  manSection: 8,
  usage: 'rsyslogd [-dnvN] [-f config file]',
  help: 'Reliable and extended syslogd.',
  options: [
    { flag: '-N', description: 'Config check level (1 = verify and exit).', takesArg: true, argName: 'level' },
    { flag: '-v', description: 'Print version and exit.' },
    { flag: '-n', description: 'Run in foreground.' },
    { flag: '-f', description: 'Read configuration from this file.', takesArg: true, argName: 'file' },
  ],

  run(ctx: LinuxCommandContext, args: string[]): string {
    return this.runWithStatusSync!(ctx, args).output;
  },

  runWithStatusSync(ctx: LinuxCommandContext, args: string[]) {
    if (args.includes('-v')) return { output: versionText(), exitCode: 0 };

    const verify = args.find((argument) => /^-N\d*$/.test(argument));
    if (verify !== undefined) {
      const running = daemon(ctx);
      if (running === null) return { output: 'rsyslogd: no configuration available', exitCode: 1 };
      const configFlag = args.indexOf('-f');
      const path = configFlag >= 0 && args[configFlag + 1] !== undefined ? args[configFlag + 1] : RSYSLOG_CONFIG_PATH;
      const level = verify.length > 2 ? Number(verify.slice(2)) : 0;
      if (level === 0) return { output: '', exitCode: 0 };
      const result = running.verify(path);
      const header = `rsyslogd: version ${RSYSLOG_VERSION}, config validation run (level ${level}), master config ${path}`;
      if (result.hadErrors) return { output: [header, ...result.lines].join('\n'), exitCode: 1 };
      return { output: [header, ...result.lines, 'rsyslogd: End of config validation run. Bye.'].join('\n'), exitCode: 0 };
    }

    return {
      output: `rsyslogd: pidfile '${PID_FILE}' and pid 1 already exist; use systemctl`,
      exitCode: 1,
    };
  },
};
