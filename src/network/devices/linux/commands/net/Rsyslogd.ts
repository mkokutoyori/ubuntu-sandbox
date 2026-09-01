
import type { LinuxCommand } from '../LinuxCommand';
import type { LinuxCommandContext } from '../LinuxCommandContext';
import { makeArgCompleter } from '../completionHelpers';

const RSYSLOGD_BINARY = '/usr/sbin/rsyslogd';
const RSYSLOGD_VERSION = '8.2112.0';

interface AvecRsyslog {
  rsyslogService?: {
    verifierConfiguration(): { verdict: 'ok' | 'faute'; erreur: string };
    recharger(): void;
    listeningPorts(): number[];
  } | null;
}

function service(ctx: LinuxCommandContext) {
  return (ctx.executor as unknown as AvecRsyslog).rsyslogService ?? null;
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
  ],

  run(ctx: LinuxCommandContext, args: string[]): string {
    return this.runWithStatusSync!(ctx, args).output;
  },

  runWithStatusSync(ctx: LinuxCommandContext, args: string[]) {
    if (args.includes('-v')) {
      return {
        output: [
          `rsyslogd ${RSYSLOGD_VERSION} (aka 2021.12) compiled with:`,
          '\tPLATFORM:\t\t\t\tx86_64-pc-linux-gnu',
          '\tFEATURE_REGEXP:\t\t\t\tYes',
          '\tGSSAPI Kerberos 5 support:\t\tYes',
          '\tConfig file:\t\t\t\t/etc/rsyslog.conf',
          '\tPID file:\t\t\t\t/var/run/rsyslogd.pid',
          '',
          'See https://www.rsyslog.com for more information.',
        ].join('\n'),
        exitCode: 0,
      };
    }

    const verif = args.find((a) => /^-N\d*$/.test(a));
    if (verif) {
      const svc = service(ctx);
      if (!svc) return { output: 'rsyslogd: no configuration available', exitCode: 1 };
      const v = svc.verifierConfiguration();
      if (v.verdict === 'faute') {
        return {
          output: [
            v.erreur,
            'rsyslogd: run failed with error -2207 (see rsyslog.conf(5) for details)',
          ].join('\n'),
          exitCode: 1,
        };
      }
      return {
        output: [
          `rsyslogd: version ${RSYSLOGD_VERSION}, config validation run (level 1), master config /etc/rsyslog.conf`,
          'rsyslogd: End of config validation run. Bye.',
        ].join('\n'),
        exitCode: 0,
      };
    }

    return {
      output: 'rsyslogd: pidfile \'/var/run/rsyslogd.pid\' and pid 1 already exist; use systemctl',
      exitCode: 1,
    };
  },
};
