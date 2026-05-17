/**
 * DateTimeCmdlets — Get-Date, New-TimeSpan, Start-Sleep.
 * No system providers required.
 */

import type { ICmdlet } from '../ICmdlet';
import type { CmdletContext } from '../CmdletContext';
import type { PSValue } from '@/powershell/runtime/PSEnvironment';
import { psValueToString } from '@/powershell/runtime/PSExpansion';

// ─── Get-Date ─────────────────────────────────────────────────────────────

export class GetDateCmdlet implements ICmdlet {
  readonly name = 'get-date';
  readonly aliases = [] as const;

  execute(ctx: CmdletContext): PSValue {
    const fmt     = ctx.named['format'] ? psValueToString(ctx.named['format']) : null;
    const dateArg = ctx.named['date'] ?? ctx.positional[0] ?? null;
    const now = new Date();
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

// ─── Start-Sleep ──────────────────────────────────────────────────────────

export class StartSleepCmdlet implements ICmdlet {
  readonly name = 'start-sleep';
  readonly aliases = ['sleep'] as const;
  execute(_ctx: CmdletContext): PSValue { return null; }
}
