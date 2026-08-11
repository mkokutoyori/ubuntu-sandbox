/**
 * `rsyslogd` — et surtout `rsyslogd -N1`, la validation de configuration.
 *
 * C'est la commande qu'un operateur lance AVANT `systemctl reload`, pour
 * la meme raison qu'il lance `nginx -t` : un rechargement sur une
 * configuration fautive coupe le service, et ici le service est ce qui
 * recoit les journaux de tout le parc — le moment ou l'on perd la trace
 * est precisement celui ou l'on en a besoin.
 *
 * `-N` prend un NIVEAU (`-N1` = verifier et sortir) ; c'est la forme
 * reelle, `-t` n'existe pas sur rsyslogd et le proposer apprendrait une
 * option que le binaire refuse.
 */

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

    // `-N<niveau>` est colle a son chiffre (`-N1`) ; c'est la forme que
    // tout le monde tape, et un decoupage naif sur `-N` seul ne la voit
    // pas — le meme piege que `lsb_release -cs`.
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

    // Lancer le demon a la main double celui de systemd. Le vrai le
    // refuse sur son fichier de PID ; le dire vaut mieux que d'ouvrir
    // une seconde ecoute que `systemctl stop` ne fermerait pas.
    return {
      output: 'rsyslogd: pidfile \'/var/run/rsyslogd.pid\' and pid 1 already exist; use systemctl',
      exitCode: 1,
    };
  },
};
