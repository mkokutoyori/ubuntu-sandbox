/**
 * DateTimeCmdlets — Get-Date, New-TimeSpan, Start-Sleep.
 * No system providers required.
 */

import type { ICmdlet } from '../ICmdlet';
import type { CmdletContext } from '../CmdletContext';
import type { PSValue } from '@/powershell/runtime/PSEnvironment';
import { psValueToString } from '@/powershell/runtime/PSExpansion';
import type { PSScriptBlock } from '@/powershell/parser/PSASTNode';
import { PSRuntimeError } from '@/powershell/runtime/PSRuntime';
import { trouverTimezone } from '@/network/devices/linux/time/TimezoneDatabase';

// ─── Get-TimeZone / Set-TimeZone ──────────────────────────────────────────

/**
 * `Get-TimeZone` / `Set-TimeZone` (`docs/PRD-NTP-Tutoriel.md` §5).
 *
 * Les deux applets n'existaient NI en cmd NI en PowerShell : le §6.3 du
 * tutoriel ne pouvait pas se suivre. Elles lisent et ecrivent le meme
 * fuseau que `timedatectl` cote Linux — le decalage vit dans une seule
 * table (`TimezoneDatabase`), sans quoi une machine Windows et une
 * machine Linux ne s'accorderaient pas sur ce qu'est `WAT`.
 *
 * Windows nomme ses fuseaux autrement que tzdata (`W. Central Africa
 * Standard Time` contre `Africa/Douala`) : la correspondance est
 * explicite plutot que devinee, et un nom inconnu est REFUSE comme le
 * vrai applet le refuse.
 */
const ZONES_WINDOWS: ReadonlyArray<{ id: string; iana: string; nom: string }> = [
  { id: 'UTC', iana: 'Etc/UTC', nom: 'Coordinated Universal Time' },
  { id: 'W. Central Africa Standard Time', iana: 'Africa/Douala', nom: 'West Central Africa' },
  { id: 'GMT Standard Time', iana: 'Europe/London', nom: 'Dublin, Edinburgh, Lisbon, London' },
  { id: 'Greenwich Standard Time', iana: 'Africa/Abidjan', nom: 'Monrovia, Reykjavik' },
  { id: 'W. Europe Standard Time', iana: 'Europe/Berlin', nom: 'Amsterdam, Berlin, Bern, Rome' },
  { id: 'Romance Standard Time', iana: 'Europe/Paris', nom: 'Brussels, Copenhagen, Madrid, Paris' },
  { id: 'South Africa Standard Time', iana: 'Africa/Johannesburg', nom: 'Harare, Pretoria' },
  { id: 'E. Africa Standard Time', iana: 'Africa/Nairobi', nom: 'Nairobi' },
  { id: 'Egypt Standard Time', iana: 'Africa/Cairo', nom: 'Cairo' },
  { id: 'Eastern Standard Time', iana: 'America/New_York', nom: 'Eastern Time (US & Canada)' },
  { id: 'Central Standard Time', iana: 'America/Chicago', nom: 'Central Time (US & Canada)' },
  { id: 'Pacific Standard Time', iana: 'America/Los_Angeles', nom: 'Pacific Time (US & Canada)' },
  { id: 'India Standard Time', iana: 'Asia/Kolkata', nom: 'Chennai, Kolkata, Mumbai, New Delhi' },
  { id: 'China Standard Time', iana: 'Asia/Shanghai', nom: 'Beijing, Chongqing, Hong Kong' },
  { id: 'Tokyo Standard Time', iana: 'Asia/Tokyo', nom: 'Osaka, Sapporo, Tokyo' },
  { id: 'Russian Standard Time', iana: 'Europe/Moscow', nom: 'Moscow, St. Petersburg' },
  { id: 'AUS Eastern Standard Time', iana: 'Australia/Sydney', nom: 'Canberra, Melbourne, Sydney' },
];

/** Le decalage d'un identifiant Windows, via la table partagee. */
function decalageDe(iana: string): number {
  return trouverTimezone(iana)?.offsetMin ?? 0;
}

function objetZone(z: { id: string; iana: string; nom: string }): PSValue {
  const min = decalageDe(z.iana);
  const signe = min < 0 ? '-' : '+';
  const abs = Math.abs(min);
  const hh = String(Math.floor(abs / 60)).padStart(2, '0');
  const mm = String(abs % 60).padStart(2, '0');
  return {
    Id: z.id,
    DisplayName: `(UTC${signe}${hh}:${mm}) ${z.nom}`,
    StandardName: z.id,
    BaseUtcOffset: `${signe}${hh}:${mm}:00`,
    SupportsDaylightSavingTime: false,
  } as unknown as PSValue;
}

export class GetTimeZoneCmdlet implements ICmdlet {
  readonly name = 'get-timezone';
  readonly aliases = [] as const;

  execute(ctx: CmdletContext): PSValue {
    if (ctx.named['listavailable'] !== undefined) {
      return ZONES_WINDOWS.map(objetZone) as unknown as PSValue;
    }
    const courante = ctx.providers.identity?.timezone ?? 'Etc/UTC';
    const z = ZONES_WINDOWS.find((x) => x.iana === courante) ?? ZONES_WINDOWS[0];
    return objetZone(z);
  }
}

export class SetTimeZoneCmdlet implements ICmdlet {
  readonly name = 'set-timezone';
  readonly aliases = [] as const;

  execute(ctx: CmdletContext): PSValue {
    const demande = ctx.named['id'] ?? ctx.named['name'] ?? ctx.positional[0];
    if (demande === undefined || demande === null) {
      throw new PSRuntimeError(
        "Set-TimeZone: Cannot bind argument to parameter 'Id' because it is null.");
    }
    const voulu = psValueToString(demande);
    const z = ZONES_WINDOWS.find((x) => x.id.toLowerCase() === voulu.toLowerCase());
    // Un identifiant inconnu est REFUSE : l'accepter reviendrait a
    // laisser croire que le fuseau a change.
    if (!z) {
      throw new PSRuntimeError(
        `Set-TimeZone: Cannot find the time zone with identifier "${voulu}" on the local computer.`);
    }
    ctx.providers.identity?.setTimezone(z.iana);
    return null;
  }
}

// ─── Get-Date ─────────────────────────────────────────────────────────────

export class GetDateCmdlet implements ICmdlet {
  readonly name = 'get-date';
  readonly aliases = [] as const;

  execute(ctx: CmdletContext): PSValue {
    const fmt     = ctx.named['format'] ? psValueToString(ctx.named['format']) : null;
    const dateArg = ctx.named['date'] ?? ctx.positional[0] ?? null;
    const now = ctx.providers.scheduledTasks?.now?.() ?? new Date();
    let d: Date;
    if (dateArg !== null && dateArg !== undefined) {
      d = new Date(psValueToString(dateArg));
      if (isNaN(d.getTime())) d = new Date();
    } else if (['year', 'month', 'day', 'hour', 'minute', 'second']
        .some(k => ctx.named[k] !== undefined)) {
      // -Year/-Month/-Day/... build a date; unspecified parts inherit "now".
      const num = (k: string, def: number) =>
        ctx.named[k] !== undefined ? Number(ctx.named[k]) : def;
      d = new Date(
        num('year',  now.getFullYear()),
        num('month', now.getMonth() + 1) - 1,
        num('day',   now.getDate()),
        num('hour',   now.getHours()),
        num('minute', now.getMinutes()),
        num('second', now.getSeconds()),
      );
    } else {
      d = now;
    }
    if (fmt !== null) return formatDate(d, fmt);
    return makePSDate(d);
  }
}

const MONTHS_FULL = ['January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'];
const DAYS_FULL = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday',
  'Friday', 'Saturday'];

// ─── Set-Date ─────────────────────────────────────────────────────────────

export class SetDateCmdlet implements ICmdlet {
  readonly name = 'set-date';
  readonly aliases = [] as const;
  execute(_ctx: CmdletContext): PSValue { return null; }
}

export function makePSDate(d: Date): PSValue {
  return Object.assign(d, {
    Year:        d.getFullYear(),
    Month:       d.getMonth() + 1,
    Day:         d.getDate(),
    Hour:        d.getHours(),
    Minute:      d.getMinutes(),
    Second:      d.getSeconds(),
    Millisecond: d.getMilliseconds(),
    DayOfWeek:   d.getDay(),
    Ticks:       d.getTime(),
  }) as unknown as PSValue;
}

function formatDate(d: Date, fmt: string): string {
  const pad2 = (n: number) => String(n).padStart(2, '0');
  const pad3 = (n: number) => String(n).padStart(3, '0');
  const h12 = d.getHours() % 12 || 12;
  // Single-pass token scan (longest-match-first) so `dddd` is not chewed up
  // by the `dd` rule, etc.
  const tokens: Array<[RegExp, () => string]> = [
    [/^yyyy/, () => String(d.getFullYear())],
    [/^yy/,   () => String(d.getFullYear()).slice(-2)],
    [/^MMMM/, () => MONTHS_FULL[d.getMonth()]],
    [/^MMM/,  () => MONTHS_FULL[d.getMonth()].slice(0, 3)],
    [/^MM/,   () => pad2(d.getMonth() + 1)],
    [/^M/,    () => String(d.getMonth() + 1)],
    [/^dddd/, () => DAYS_FULL[d.getDay()]],
    [/^ddd/,  () => DAYS_FULL[d.getDay()].slice(0, 3)],
    [/^dd/,   () => pad2(d.getDate())],
    [/^d/,    () => String(d.getDate())],
    [/^HH/,   () => pad2(d.getHours())],
    [/^H/,    () => String(d.getHours())],
    [/^hh/,   () => pad2(h12)],
    [/^h/,    () => String(h12)],
    [/^mm/,   () => pad2(d.getMinutes())],
    [/^m/,    () => String(d.getMinutes())],
    [/^ss/,   () => pad2(d.getSeconds())],
    [/^s/,    () => String(d.getSeconds())],
    [/^fff/,  () => pad3(d.getMilliseconds())],
    [/^tt/,   () => (d.getHours() < 12 ? 'AM' : 'PM')],
  ];
  let out = '';
  for (let i = 0; i < fmt.length; ) {
    const rest = fmt.slice(i);
    const hit = tokens.find(([re]) => re.test(rest));
    if (hit) {
      const m = rest.match(hit[0])![0];
      out += hit[1]();
      i += m.length;
    } else {
      out += fmt[i];
      i++;
    }
  }
  return out;
}

// ─── New-TimeSpan ─────────────────────────────────────────────────────────

export class NewTimespanCmdlet implements ICmdlet {
  readonly name = 'new-timespan';
  readonly displayName = 'New-TimeSpan';
  readonly aliases = [] as const;

  execute(ctx: CmdletContext): PSValue {
    const days  = Number(ctx.named['days']    ?? 0);
    const hours = Number(ctx.named['hours']   ?? 0);
    const mins  = Number(ctx.named['minutes'] ?? 0);
    const secs  = Number(ctx.named['seconds'] ?? 0);
    const ms    = days * 86400000 + hours * 3600000 + mins * 60000 + secs * 1000;
    return makeTimeSpan(ms);
  }
}

export function makeTimeSpan(ms: number): Record<string, PSValue> {
  const total = ms / 1000;
  return {
    __type:       'TimeSpan',
    TotalMilliseconds: ms,
    TotalSeconds: total,
    TotalMinutes: total / 60,
    TotalHours:   total / 3600,
    TotalDays:    total / 86400,
    Days:         Math.floor(total / 86400),
    Hours:        Math.floor((total % 86400) / 3600),
    Minutes:      Math.floor((total % 3600) / 60),
    Seconds:      Math.floor(total % 60),
    Milliseconds: ms % 1000,
  } as Record<string, PSValue>;
}

// ─── Measure-Command ──────────────────────────────────────────────────────

export class MeasureCommandCmdlet implements ICmdlet {
  readonly name = 'measure-command';
  readonly displayName = 'Measure-Command';
  readonly aliases = [] as const;

  execute(ctx: CmdletContext): PSValue {
    const raw = ctx.named['expression'] ?? ctx.positional[0] ?? null;
    if (!raw || typeof raw !== 'object' || (raw as Record<string, unknown>).type !== 'ScriptBlock') {
      ctx.emitError('Measure-Command requires a script block, e.g. Measure-Command { ... }');
      return makeTimeSpan(0);
    }
    const start = Date.now();
    ctx.invokeBlock(raw as PSScriptBlock);
    return makeTimeSpan(Date.now() - start);
  }
}

// ─── Start-Sleep ──────────────────────────────────────────────────────────

export class StartSleepCmdlet implements ICmdlet {
  readonly name = 'start-sleep';
  readonly aliases = ['sleep'] as const;
  execute(ctx: CmdletContext): PSValue {
    const seconds = ctx.named['seconds'] ?? ctx.positional[0];
    const millis = ctx.named['milliseconds'];
    let ms = 0;
    if (millis != null) ms += Number(millis);
    if (seconds != null) ms += Number(seconds) * 1000;
    if (ms > 0) ctx.providers.jobs?.recordSleep(ms);
    return null;
  }
}
