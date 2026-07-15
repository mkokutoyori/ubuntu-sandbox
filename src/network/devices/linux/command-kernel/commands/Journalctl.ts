import { ParsedArgs } from '@/command-kernel/args/parsed-args';
import { BaseCommand } from '@/command-kernel/command/base-command';
import { CommandContext, CommandDescriptor, ExitCode } from '@/command-kernel/command/types';
import { JournalRecord } from '@/command-kernel/machine/types';
import { DefaultPrivilegePolicy } from '@/command-kernel/session/privilege-policy';
import { PrivilegeLevel, Session } from '@/command-kernel/session/types';
import { PRIORITY_NAMES, FACILITY_NAMES, formatSyslogTimestamp, formatIsoTimestamp, formatHumanDate } from './syslog';

const HELP = `journalctl [OPTIONS...] [MATCHES...]

Query the journal.

Options:
  -n --lines=INTEGER   Number of journal entries to show
  -r --reverse         Show the newest entries first
  -u --unit=UNIT       Show logs from the specified unit
  -p --priority=RANGE  Show entries with the specified priority
  -k --dmesg           Show kernel message log from the current boot
  -o --output=STRING   Change journal output mode
  -b --boot[=ID]       Show data only from the specified boot
  -N --fields          List all field names currently used
  --since=DATE         Show entries not older than the specified date
  --until=DATE         Show entries not newer than the specified date
     --no-pager        Do not pipe output into a pager
  -h --help            Show this help text`;

const VALID_FORMATS = ['short', 'short-iso', 'json', 'json-pretty', 'cat', 'verbose'];

/**
 * `journalctl [OPTIONS...]` — interroge le journal système. Commande
 * **autonome** : lit les enregistrements via `ctx.machine.logging`
 * (`journalEntries`/`journalActive`/`bootTime`/`bootId`), puis filtre,
 * tronque, inverse et formate elle-même (6 modes de sortie).
 */
export class JournalctlCommand extends BaseCommand {
  readonly descriptor: CommandDescriptor = {
    name: 'journalctl',
    summary: 'Interroge le journal système (journald)',
    usage: 'journalctl [OPTIONS...] [MATCHES...]',
    args: [{ name: 'operands', type: 'string', required: false, variadic: true, description: '[options] [matches]' }],
    options: [],
    privileges: new DefaultPrivilegePolicy(PrivilegeLevel.ANY),
    category: 'système',
    lenientOptions: true,
  };

  /**
   * `-f`/`--follow` tient le terminal et diffuse les nouvelles entrées du
   * journal au fil de l'eau : l'invocation est en flux continu (§14.6),
   * sinon c'est un instantané. La commande décide selon ses arguments.
   */
  override isStreaming(argv: readonly string[]): boolean {
    return argv.some((a) => a === '-f' || a === '--follow');
  }

  protected override validate(_args: ParsedArgs, _session: Session): void {
    // Erreurs d'usage (format inconnu, priorité/nombre invalide) rendues
    // dans `execute` avec le message exact et le code de sortie 1.
  }

  async execute(ctx: CommandContext): Promise<ExitCode> {
    const args = ctx.args.has('operands') ? ctx.args.get<string[]>('operands') : [];
    const logging = ctx.machine.logging;
    if (!logging) return 1;

    // Sous-commandes / requêtes qui court-circuitent l'affichage du journal.
    for (const arg of args) {
      if (arg === '--version') return this.emit(ctx, 'systemd 249 (249.11-0ubuntu3)');
      if (arg === '-h' || arg === '--help') return this.emit(ctx, HELP);
      if (arg === '-N' || arg === '--fields') {
        return this.emit(ctx, ['MESSAGE', 'PRIORITY', 'SYSLOG_FACILITY', 'SYSLOG_IDENTIFIER',
          '_PID', '_UID', '_GID', '_HOSTNAME', '_TRANSPORT', '_SYSTEMD_UNIT',
          '__REALTIME_TIMESTAMP', '__MONOTONIC_TIMESTAMP'].join('\n'));
      }
      if (arg === '--disk-usage') return this.emit(ctx, this.diskUsage(logging.journalEntries().length));
      if (arg === '--list-boots') return this.emit(ctx, ` 0 ${logging.bootId()} ${formatHumanDate(logging.bootTime())}—${formatHumanDate(new Date())}`);
      if (arg === '--rotate') return this.emit(ctx, 'Rotating journal files...');
      if (arg === '--flush') return this.emit(ctx, 'Flushing journal to persistent storage...');
      if (arg.startsWith('--vacuum-time') || arg.startsWith('--vacuum-size')) {
        return this.emit(ctx, 'Vacuuming done, freed 0B of archived journals.');
      }
    }

    if (!logging.journalActive()) return this.emit(ctx, 'No journal files were found.');

    let n = -1;
    let reverse = false;
    let quiet = false;
    let outputFormat = 'short';
    let unitFilter = '';
    let priorityFilter = -1;
    let pidFilter = -1;
    let outputFields: string[] = [];
    let kernelOnly = false;
    let sinceMs = -1;
    let untilMs = -1;
    let follow = false;

    for (let i = 0; i < args.length; i++) {
      switch (args[i]) {
        case '-n': case '--lines': {
          const v = args[++i] ?? '';
          if (!/^\d+$/.test(v)) return this.emit(ctx, `journalctl: invalid number of lines: "${v}".`);
          n = parseInt(v, 10); break;
        }
        case '-r': case '--reverse': reverse = true; break;
        case '-q': case '--quiet': quiet = true; break;
        case '-k': case '--dmesg': kernelOnly = true; break;
        case '-f': case '--follow': follow = true; break;
        case '-x': case '--catalog': break;
        case '-b': case '--boot': {
          const nxt = args[i + 1];
          if (nxt && /^-?\d+$/.test(nxt)) {
            if (parseInt(nxt, 10) < 0) return this.emit(ctx, `Failed to look up boot ${nxt}: no such boot ID`);
            i++;
          }
          break;
        }
        case '-D': case '--directory': {
          const dir = args[++i] ?? '';
          if (dir.startsWith('/sys') || dir.startsWith('/proc')) return this.emit(ctx, `Failed to open directory ${dir}: error`);
          break;
        }
        case '--since': case '-S': sinceMs = this.parseTime(args[++i] ?? ''); break;
        case '--until': case '-U': untilMs = this.parseTime(args[++i] ?? ''); break;
        case '--no-pager': break;
        case '-o': case '--output': outputFormat = args[++i] || 'short'; break;
        case '-u': case '--unit': unitFilter = args[++i] || ''; break;
        case '-p': case '--priority': {
          const pval = args[++i] || '';
          const pnum = this.resolvePriority(pval);
          if (pnum === -1) return this.emit(ctx, `Invalid priority: ${pval}`);
          priorityFilter = pnum; break;
        }
        default: {
          const a = args[i];
          if (a.startsWith('--facility')) break;
          if (a.startsWith('_PID=')) pidFilter = parseInt(a.slice(5), 10);
          if (a.startsWith('--output-fields=')) outputFields = a.slice(16).split(',');
          break;
        }
      }
    }

    if (!VALID_FORMATS.includes(outputFormat)) {
      return this.emit(ctx, `Invalid argument: unknown output format "${outputFormat}".`);
    }

    const all = logging.journalEntries();
    let entries = all.filter((e) => this.matches(e, unitFilter, priorityFilter, pidFilter));
    if (kernelOnly) entries = entries.filter((e) => e.facility === FACILITY_NAMES.kern);
    if (sinceMs >= 0) entries = entries.filter((e) => e.timestampMs >= sinceMs);
    if (untilMs >= 0) entries = entries.filter((e) => e.timestampMs <= untilMs);

    // journald ne renvoie jamais d'entrées horodatées dans le futur (les
    // messages de boot synthétiques peuvent dépasser l'horloge murale sur
    // un hôte tout juste démarré).
    const nowMs = Date.now();
    entries = entries.filter((e) => e.timestampMs <= nowMs);

    // En mode suivi, l'instantané par défaut se limite aux 10 dernières
    // entrées (comme `journalctl -f`), avant de diffuser la suite.
    if (follow && n < 0) n = 10;

    let snapshot: string;
    if (entries.length === 0) {
      snapshot = '-- No entries --';
    } else {
      if (n >= 0) entries = entries.slice(-n);
      if (reverse) entries = [...entries].reverse();
      const bootId = logging.bootId();
      const lines = entries.map((e) => this.formatEntry(e, outputFormat, outputFields, bootId));
      if (!quiet && !reverse && (outputFormat === 'short' || outputFormat === 'short-iso') && all.length > 0) {
        const header = `-- Logs begin at ${formatHumanDate(new Date(all[0].timestampMs))}, end at ${formatHumanDate(new Date(all[all.length - 1].timestampMs))}. --`;
        snapshot = header + '\n' + lines.join('\n');
      } else {
        snapshot = lines.join('\n');
      }
    }

    // Mode suivi (§14.6) : après l'instantané, diffuse les nouvelles entrées
    // au fil de l'eau jusqu'à Ctrl+C (`ctx.signal`). Seulement sous un flux
    // terminal vivant (`ctx.io.interaction`) : un appel programmatique
    // (`executeCommand`/script, sans annulation) rend juste l'instantané au
    // lieu de bloquer indéfiniment.
    if (follow && logging.followJournal && ctx.io.interaction) {
      if (snapshot !== '') await ctx.io.stdout.write(snapshot + '\n');
      const unsub = logging.followJournal(
        {
          unit: unitFilter || undefined,
          priority: priorityFilter >= 0 ? priorityFilter : undefined,
          pid: pidFilter >= 0 ? pidFilter : undefined,
        },
        (line) => { void ctx.io.stdout.write(line.endsWith('\n') ? line : `${line}\n`); },
      );
      await new Promise<void>((resolve) => {
        if (ctx.signal.aborted) { resolve(); return; }
        ctx.signal.addEventListener('abort', () => resolve(), { once: true });
      });
      unsub();
      return 0;
    }
    return this.emit(ctx, snapshot);
  }

  private async emit(ctx: CommandContext, text: string): Promise<ExitCode> {
    if (text !== '') await ctx.io.stdout.write(text + '\n');
    // Sémantique de code de sortie du legacy : 1 seulement si la sortie
    // commence par « Invalid » (priorité / format inconnus), 0 sinon — y
    // compris pour les erreurs « journalctl: … » / « Failed … ».
    return text.startsWith('Invalid') ? 1 : 0;
  }

  private matches(e: JournalRecord, unit: string, priority: number, pid: number): boolean {
    if (unit) {
      const u = unit.replace(/\.service$/, '');
      const hit = (e.unit && e.unit.includes(u))
        || (e.tag && e.tag.includes(u))
        || e.message.startsWith(`${u}.service`)
        || e.message.includes(`${u}.service:`)
        || e.message.includes(`${u}[`);
      if (!hit) return false;
    }
    if (priority >= 0 && e.priority > priority) return false;
    if (pid >= 0 && e.pid !== pid) return false;
    return true;
  }

  private parseTime(spec: string): number {
    const s = spec.trim().toLowerCase();
    if (s === '' || s === 'now') return Date.now();
    const ago = s.match(/^(\d+)\s*(second|minute|hour|day|week)s?\s*(ago)?$/);
    if (ago) {
      const mult: Record<string, number> = {
        second: 1000, minute: 60_000, hour: 3_600_000, day: 86_400_000, week: 604_800_000,
      };
      return Date.now() - parseInt(ago[1], 10) * mult[ago[2]];
    }
    const t = Date.parse(spec);
    return isNaN(t) ? Date.now() : t;
  }

  private resolvePriority(val: string): number {
    const num = parseInt(val, 10);
    if (!isNaN(num) && num >= 0 && num <= 7) return num;
    const pri = PRIORITY_NAMES[val];
    return pri !== undefined ? pri : -1;
  }

  private diskUsage(count: number): string {
    const bytes = count * 128;
    let size: string;
    if (bytes < 1024) size = `${bytes}B`;
    else if (bytes < 1024 * 1024) size = `${(bytes / 1024).toFixed(1)}K`;
    else size = `${(bytes / (1024 * 1024)).toFixed(1)}M`;
    return `Archived and active journals take up ${size} in the file system.`;
  }

  private formatEntry(e: JournalRecord, format: string, outputFields: string[], bootId: string): string {
    const showPid = e.pid > 0 && e.displayPid !== false;
    switch (format) {
      case 'short': {
        const pidPart = showPid ? `[${e.pid}]` : '';
        return `${formatSyslogTimestamp(new Date(e.timestampMs))} ${e.hostname} ${e.tag}${pidPart}: ${e.message}`;
      }
      case 'short-iso': {
        const pidPart = showPid ? `[${e.pid}]` : '';
        return `${formatIsoTimestamp(new Date(e.timestampMs))} ${e.hostname} ${e.tag}${pidPart}: ${e.message}`;
      }
      case 'cat':
        return e.message;
      case 'json':
      case 'json-pretty': {
        const obj: Record<string, string> = {
          '__REALTIME_TIMESTAMP': String(e.timestampMs * 1000),
          '_HOSTNAME': e.hostname,
          'PRIORITY': String(e.priority),
          'SYSLOG_FACILITY': String(e.facility),
          'SYSLOG_IDENTIFIER': e.tag,
          '_PID': String(e.pid),
          'MESSAGE': e.message,
          '_SYSTEMD_UNIT': e.unit || '',
        };
        let filtered = obj;
        if (outputFields.length > 0) {
          filtered = {};
          for (const f of outputFields) if (f in obj) filtered[f] = obj[f];
        }
        return format === 'json-pretty' ? JSON.stringify(filtered, null, 4) : JSON.stringify(filtered);
      }
      case 'verbose':
        return [
          `${formatHumanDate(new Date(e.timestampMs))} [s=${bootId}]`,
          `    PRIORITY=${e.priority}`,
          `    SYSLOG_FACILITY=${e.facility}`,
          `    SYSLOG_IDENTIFIER=${e.tag}`,
          `    MESSAGE=${e.message}`,
          `    _PID=${e.pid}`,
          `    _HOSTNAME=${e.hostname}`,
          `    _SYSTEMD_UNIT=${e.unit}`,
        ].join('\n');
      default:
        return e.message;
    }
  }
}
