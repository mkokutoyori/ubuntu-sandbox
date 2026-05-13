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
    const fmt    = ctx.named['format'] ? psValueToString(ctx.named['format']) : null;
    const dateArg = ctx.named['date'] ?? ctx.named['year'] ?? ctx.positional[0] ?? null;
    let d: Date;
    if (dateArg !== null && dateArg !== undefined) {
      d = new Date(psValueToString(dateArg));
      if (isNaN(d.getTime())) d = new Date();
    } else {
      d = new Date();
    }
    if (fmt !== null) return formatDate(d, fmt);
    return makePSDate(d);
  }
}

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
  return fmt
    .replace(/yyyy/g, String(d.getFullYear()))
    .replace(/yy/g,   String(d.getFullYear()).slice(-2))
    .replace(/MM/g,   pad2(d.getMonth() + 1))
    .replace(/dd/g,   pad2(d.getDate()))
    .replace(/HH/g,   pad2(d.getHours()))
    .replace(/mm/g,   pad2(d.getMinutes()))
    .replace(/ss/g,   pad2(d.getSeconds()))
    .replace(/fff/g,  pad3(d.getMilliseconds()));
}

// ─── New-TimeSpan ─────────────────────────────────────────────────────────

export class NewTimespanCmdlet implements ICmdlet {
  readonly name = 'new-timespan';
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
