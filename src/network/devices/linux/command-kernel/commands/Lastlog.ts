import { BaseCommand } from '@/command-kernel/command/base-command';
import type { CommandContext, CommandDescriptor, ExitCode } from '@/command-kernel/command/types';
import { EXIT_OK } from '@/command-kernel/command/types';
import { DefaultPrivilegePolicy } from '@/command-kernel/session/privilege-policy';
import { PrivilegeLevel } from '@/command-kernel/session/types';

const ANY = new DefaultPrivilegePolicy(PrivilegeLevel.ANY);

const LASTLOG_HELP = [
  '',
  'Usage:',
  ' lastlog [options]',
  '',
  'Reports the most recent login of all users or of a given user.',
  '',
  'Options:',
  ' -b, --before DAYS    print only lastlog records older than DAYS',
  ' -C, --clear          clear lastlog record of a user (usable only with -u)',
  ' -R, --root CHROOT_DIR  directory to chroot into',
  ' -S, --set            set lastlog record to current time (usable only with -u)',
  ' -t, --time DAYS      print only lastlog records more recent than DAYS',
  ' -u, --user LOGIN     print lastlog record of the specified LOGIN',
  ' -h, --help           display this help',
  ' -V, --version        display version',
].join('\n');

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const pad2 = (n: number): string => String(n).padStart(2, '0');

/** `lastlog [options]` — dernière connexion par utilisateur via `machine.lastlog`. */
export class LastlogCommand extends BaseCommand {
  readonly descriptor: CommandDescriptor = {
    name: 'lastlog',
    summary: 'Affiche la dernière connexion de chaque utilisateur',
    usage: 'lastlog [options]',
    args: [
      { name: 'rest', type: 'string', required: false, variadic: true, description: '-u/-b/-t/-C/-S/-h/-V' },
    ],
    options: [],
    privileges: ANY,
    category: 'linux',
    lenientOptions: true,
  };

  async execute(ctx: CommandContext): Promise<ExitCode> {
    const args = ctx.args.get<string[] | undefined>('rest') ?? [];
    const oracle = ctx.machine.lastlog!;

    let filterUser: string | null = null;
    let beforeDays: number | null = null;
    let timeDays: number | null = null;
    let clear = false;
    let setNow = false;

    for (let i = 0; i < args.length; i++) {
      const a = args[i];
      if (a === '-h' || a === '--help') { await ctx.io.stdout.write(LASTLOG_HELP + '\n'); return EXIT_OK; }
      if (a === '-V' || a === '--version') { await ctx.io.stdout.write('lastlog from util-linux 2.37.2\n'); return EXIT_OK; }
      if (a === '-u' || a === '--user') { filterUser = args[++i] ?? null; continue; }
      if (a === '-b' || a === '--before') { beforeDays = Number(args[++i]); continue; }
      if (a === '-t' || a === '--time') { timeDays = Number(args[++i]); continue; }
      if (a === '-C' || a === '--clear') { clear = true; continue; }
      if (a === '-S' || a === '--set') { setNow = true; continue; }
      if (a === '-R' || a === '--root') { i++; continue; }
    }

    if (clear || setNow) {
      if (!filterUser) { await ctx.io.stdout.write('lastlog: option requires -u/--user\n'); return EXIT_OK; }
      if (clear) oracle.clear(filterUser);
      if (setNow) oracle.setNow(filterUser);
      return EXIT_OK;
    }

    const accounts = oracle.accounts();
    let userFilter: ((u: { username: string; uid: number }) => boolean) | null = null;
    if (filterUser !== null) {
      const range = /^(\d*)-(\d*)$/.exec(filterUser);
      if (range && (range[1] !== '' || range[2] !== '')) {
        const lo = range[1] === '' ? 0 : Number(range[1]);
        const hi = range[2] === '' ? Number.MAX_SAFE_INTEGER : Number(range[2]);
        userFilter = (u) => u.uid >= lo && u.uid <= hi;
      } else if (/^\d+$/.test(filterUser)) {
        const uid = Number(filterUser);
        if (!accounts.some((u) => u.uid === uid)) {
          await ctx.io.stdout.write(`lastlog: Unknown user or range: ${filterUser}\n`);
          return EXIT_OK;
        }
        userFilter = (u) => u.uid === uid;
      } else {
        if (!accounts.some((u) => u.username === filterUser)) {
          await ctx.io.stdout.write(`lastlog: Unknown user or range: ${filterUser}\n`);
          return EXIT_OK;
        }
        userFilter = (u) => u.username === filterUser;
      }
    }

    const rows: string[] = ['Username         Port     From             Latest'];
    const now = Date.now();
    const beforeCutoff = beforeDays !== null && Number.isFinite(beforeDays) ? now - beforeDays * 86400_000 : null;
    const timeCutoff = timeDays !== null && Number.isFinite(timeDays) ? now - timeDays * 86400_000 : null;

    for (const u of accounts) {
      if (userFilter && !userFilter(u)) continue;
      const entry = oracle.current(u.username);
      if (!entry) {
        rows.push(`${u.username.padEnd(16)} ${''.padEnd(8)} ${''.padEnd(16)} **Never logged in**`);
        continue;
      }
      if (beforeCutoff !== null && entry.when >= beforeCutoff) continue;
      if (timeCutoff !== null && entry.when < timeCutoff) continue;
      const d = new Date(entry.when);
      const latest = `${DAYS[d.getUTCDay()]} ${MONTHS[d.getUTCMonth()]} ${pad2(d.getUTCDate())} ` +
        `${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}:${pad2(d.getUTCSeconds())} +0000 ${d.getUTCFullYear()}`;
      rows.push(`${u.username.padEnd(16)} ${entry.tty.padEnd(8)} ${entry.sourceHost.padEnd(16)} ${latest}`);
    }
    await ctx.io.stdout.write(rows.join('\n') + '\n');
    return EXIT_OK;
  }
}
