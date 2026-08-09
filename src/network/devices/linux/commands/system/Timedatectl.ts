/**
 * PRD-NTP-Tutoriel.md §4 / lot N3 — `timedatectl`.
 *
 * Sur une machine sans AUCUN demon de temps, la commande affirmait :
 *
 *     System clock synchronized: yes
 *                   NTP service: active
 *
 * Deux faits que rien ne soutenait. Elle ecrivait aussi le decalage
 * `(UTC, +0000)` EN DUR quel que soit le fuseau, et
 * `set-timezone Africa/Douala` etait accepte sans rien changer :
 * `list-timezones` ne rendait rien, `/etc/localtime` n'existait pas.
 *
 * Les deux affirmations sont desormais LUES : la synchronisation vient
 * de l'agent NTP, le service de l'unite `chrony`.
 */
import type { LinuxCommand } from '../LinuxCommand';
import type { LinuxCommandContext } from '../LinuxCommandContext';
import {
  trouverTimezone, listerTimezones, formatOffset,
} from '../../time/TimezoneDatabase';

const JOURS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function estampille(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${JOURS[d.getUTCDay()]} ${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-`
    + `${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}`;
}

/** Le rapport de statut, monte sur ce que la machine sait vraiment. */
function statut(ctx: LinuxCommandContext): string {
  const nomZone = ctx.executor.identity.timezone;
  const zone = trouverTimezone(nomZone);
  const offsetMin = zone?.offsetMin ?? 0;
  const utc = new Date();
  const local = new Date(utc.getTime() + offsetMin * 60_000);
  const agent = ctx.executor.ntpAgent?.();
  const chrony = ctx.executor.chronyService;
  // `NTP service` est l'etat du DEMON, `System clock synchronized` celui
  // de l'horloge : les deux peuvent differer, et c'est precisement le
  // cas qu'un depannage cherche (service actif, horloge non synchrone).
  const serviceActif = chrony?.isRunning() ?? false;
  const synchro = serviceActif && (agent?.isSynced() ?? false);
  return [
    `               Local time: ${estampille(local)} ${zone?.abbr ?? 'UTC'}`,
    `           Universal time: ${estampille(utc)} UTC`,
    `                 RTC time: ${estampille(utc)}`,
    `                Time zone: ${nomZone} (${zone?.abbr ?? 'UTC'}, ${formatOffset(offsetMin)})`,
    `System clock synchronized: ${synchro ? 'yes' : 'no'}`,
    `              NTP service: ${serviceActif ? 'active' : 'inactive'}`,
    `          RTC in local TZ: no`,
  ].join('\n');
}

export const timedatectlCommand: LinuxCommand = {
  name: 'timedatectl',
  needsNetworkContext: true,
  binaryPath: '/usr/bin/timedatectl',
  usage: 'timedatectl [status|show|list-timezones|set-timezone ZONE|set-ntp BOOL]',
  run(ctx: LinuxCommandContext, argv: string[]): string {
    const sous = (argv[0] ?? 'status').toLowerCase();
    switch (sous) {
      case 'status': return statut(ctx);
      case 'list-timezones': return listerTimezones().join('\n');
      case 'set-timezone': {
        const demande = argv[1];
        if (!demande) return 'Too few arguments.';
        const zone = trouverTimezone(demande);
        // Un nom inconnu est REFUSE : il l'etait deja par le vrai
        // `timedatectl`, et l'accepter revenait a laisser croire que le
        // fuseau avait change.
        if (!zone) return `Failed to set time zone: Invalid time zone '${demande}'`;
        ctx.executor.identity.setTimezone(zone.nom);
        // Les deux fichiers que systemd ecrit vraiment : sans eux,
        // `cat /etc/timezone` contredirait `timedatectl` sur la meme
        // machine.
        ctx.executor.vfs.writeFile('/etc/timezone', `${zone.nom}\n`, 0, 0, 0o022, true);
        ctx.executor.vfs.writeFile('/etc/localtime',
          `TZif2 ${zone.nom} ${formatOffset(zone.offsetMin)}\n`, 0, 0, 0o022, true);
        return '';
      }
      case 'set-ntp': {
        const on = /^(1|true|yes|on)$/i.test(argv[1] ?? '');
        const r = on
          ? ctx.executor.serviceMgr.start('chrony')
          : ctx.executor.serviceMgr.stop('chrony');
        return r && typeof r === 'object' && 'error' in r && r.error ? String(r.error) : '';
      }
      case 'show': {
        const nomZone = ctx.executor.identity.timezone;
        const zone = trouverTimezone(nomZone);
        const agent = ctx.executor.ntpAgent?.();
        const actif = ctx.executor.chronyService?.isRunning() ?? false;
        return [
          `Timezone=${nomZone}`,
          `LocalRTC=no`,
          `CanNTP=yes`,
          `NTP=${actif ? 'yes' : 'no'}`,
          `NTPSynchronized=${actif && (agent?.isSynced() ?? false) ? 'yes' : 'no'}`,
          `TimeUSec=${Date.now() * 1000}`,
          `TimezoneOffset=${zone?.offsetMin ?? 0}`,
        ].join('\n');
      }
      default:
        return `Unknown command verb ${sous}.`;
    }
  },
};
