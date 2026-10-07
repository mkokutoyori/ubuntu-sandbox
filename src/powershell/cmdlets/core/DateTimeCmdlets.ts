/**
 * DateTimeCmdlets — Get-Date, New-TimeSpan, Start-Sleep.
 * No system providers required.
 */

import { simulationNowMs } from '@/network/core/SystemClock';

import type { ICmdlet } from '../ICmdlet';
import type { CmdletContext } from '../CmdletContext';
import type { PSValue } from '@/powershell/runtime/PSEnvironment';
import { psValueToString } from '@/powershell/runtime/PSExpansion';
import { makeTimeSpan } from '@/powershell/runtime/dotnetTimeSpan';
import { formatDotNetDate } from '@/powershell/runtime/dotnetDateFormat';
import { machineDate, parseDateTime } from '@/powershell/runtime/dotnetDateTime';
import { ZonedDate } from '@/network/core/time/ZonedDate';
import { formatLocalTime } from '@/network/devices/linux/system/SystemInfo';
import type { PSScriptBlock } from '@/powershell/parser/PSASTNode';
import { PSRuntimeError } from '@/powershell/runtime/PSRuntime';
import { TimeZone } from '@/network/core/time/TimeZone';
import { WINDOWS_TIME_ZONES as ZONES_WINDOWS, windowsStandardOffset, windowsZoneDisplayName, type WindowsTimeZone } from '@/network/core/time/WindowsTimeZones';
import {
  observesDaylightSaving, standardOffsetMinutes,
} from '@/network/core/time/TimeZoneRegistry';

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

function objetZone(z: WindowsTimeZone): PSValue {
  const zone = TimeZone.parse(z.iana);
  const maintenant = simulationNowMs();
  return {
    Id: z.id,
    DisplayName: windowsZoneDisplayName(z, maintenant),
    StandardName: z.id,
    BaseUtcOffset: `${windowsStandardOffset(z, maintenant)}:00`,
    SupportsDaylightSavingTime: zone !== null && observesDaylightSaving(zone, maintenant),
  } as unknown as PSValue;
}

export class GetTimeZoneCmdlet implements ICmdlet {
  readonly name = 'get-timezone';
  readonly aliases = [] as const;
  readonly parameters = ['ListAvailable'] as const;

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
  readonly parameters = ['Id', 'Name'] as const;

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
  readonly parameters = ['Date', 'Format', 'UFormat', 'AsUTC', 'Year', 'Month', 'Day', 'Hour', 'Minute', 'Second', 'Millisecond', 'DisplayHint'] as const;

  execute(ctx: CmdletContext): PSValue {
    const fmt = ctx.named['format'] ? psValueToString(ctx.named['format']) : null;
    const ufmt = ctx.named['uformat'] ? psValueToString(ctx.named['uformat']) : null;
    const dateArg = ctx.named['date'] ?? ctx.positional[0] ?? null;
    const now = machineDate(ctx.providers);
    let d: Date;
    if (dateArg !== null && dateArg !== undefined) {
      if (dateArg instanceof Date) d = dateArg;
      else {
        const parsed = parseDateTime(psValueToString(dateArg), ctx.providers);
        if (parsed === null) {
          ctx.emitError(`Get-Date : Cannot bind parameter 'Date'. Cannot convert value "${psValueToString(dateArg)}" to type "System.DateTime".`);
          return null;
        }
        d = parsed;
      }
    } else if (['year', 'month', 'day', 'hour', 'minute', 'second', 'millisecond'].some(k => ctx.named[k] !== undefined)) {
      const num = (k: string, def: number) => (ctx.named[k] !== undefined ? Number(ctx.named[k]) : def);
      d = now.withInstant(now.getTime());
      d.setFullYear(num('year', now.getFullYear()), num('month', now.getMonth() + 1) - 1, num('day', now.getDate()));
      d.setHours(num('hour', now.getHours()), num('minute', now.getMinutes()), num('second', now.getSeconds()), num('millisecond', now.getMilliseconds()));
    } else {
      d = now;
    }
    if (ctx.named['asutc'] !== undefined) d = new ZonedDate(d.getTime(), null);
    if (ufmt !== null) return formatUFormat(ufmt, d);
    if (fmt !== null) return formatDotNetDate(d, fmt);
    return makePSDate(d);
  }
}

function formatUFormat(format: string, d: Date): string {
  const zone = d instanceof ZonedDate ? (d.zoneOrNull()?.name ?? undefined) : undefined;
  const offset = d instanceof ZonedDate ? d.offsetMinutes() : 0;
  const sign = offset < 0 ? '-' : '+';
  const hours = String(Math.floor(Math.abs(offset) / 60)).padStart(2, '0');
  const withOffset = format.replace(/%(.)/g, (whole, ch: string) => (ch === 'Z' ? `${sign}${hours}` : whole));
  return formatLocalTime(withOffset, d.getTime(), zone);
}

// ─── Set-Date ─────────────────────────────────────────────────────────────

export class SetDateCmdlet implements ICmdlet {
  readonly name = 'set-date';
  readonly aliases = [] as const;
  readonly parameters = ['Date', 'Adjust'] as const;

  execute(ctx: CmdletContext): PSValue {
    const tasks = ctx.providers.scheduledTasks;
    const now = machineDate(ctx.providers);
    const adjust = ctx.named['adjust'];
    const dateArg = ctx.named['date'] ?? ctx.positional[0];
    let target: Date;
    if (adjust !== undefined && typeof adjust === 'object' && adjust !== null && 'TotalMilliseconds' in (adjust as Record<string, PSValue>)) {
      target = now.withInstant(now.getTime() + Number((adjust as Record<string, PSValue>).TotalMilliseconds));
    } else if (dateArg !== undefined && dateArg !== null) {
      const parsed = dateArg instanceof Date ? dateArg : parseDateTime(psValueToString(dateArg), ctx.providers);
      if (parsed === null) {
        ctx.emitError(`Set-Date : Cannot bind parameter 'Date'. Cannot convert value "${psValueToString(dateArg)}" to type "System.DateTime".`);
        return null;
      }
      target = parsed;
    } else {
      ctx.emitError('Set-Date : Cannot process command because of one or more missing mandatory parameters: Date.');
      return null;
    }
    if (tasks?.setNow?.(target.getTime()) !== true) {
      ctx.emitError('Set-Date : Cannot set the system time: A required privilege is not held by the client.');
      return null;
    }
    return makePSDate(target);
  }
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

// ─── New-TimeSpan ─────────────────────────────────────────────────────────

export class NewTimespanCmdlet implements ICmdlet {
  readonly name = 'new-timespan';
  readonly displayName = 'New-TimeSpan';
  readonly aliases = [] as const;
  readonly parameters = ['Days', 'Hours', 'Minutes', 'Seconds', 'Start', 'End'] as const;

  execute(ctx: CmdletContext): PSValue {
    const start = ctx.named['start'] ?? ctx.positional[0];
    if (start instanceof Date) {
      const end = ctx.named['end'] ?? ctx.positional[1] ?? new Date(simulationNowMs());
      return makeTimeSpan((end instanceof Date ? end : new Date(String(end))).getTime() - start.getTime());
    }
    const days  = Number(ctx.named['days']    ?? 0);
    const hours = Number(ctx.named['hours']   ?? 0);
    const mins  = Number(ctx.named['minutes'] ?? 0);
    const secs  = Number(ctx.named['seconds'] ?? 0);
    const ms    = days * 86400000 + hours * 3600000 + mins * 60000 + secs * 1000;
    return makeTimeSpan(ms);
  }
}

// ─── Measure-Command ──────────────────────────────────────────────────────

export class MeasureCommandCmdlet implements ICmdlet {
  readonly name = 'measure-command';
  readonly displayName = 'Measure-Command';
  readonly aliases = [] as const;
  readonly parameters = ['Expression'] as const;

  execute(ctx: CmdletContext): PSValue {
    const raw = ctx.named['expression'] ?? ctx.positional[0] ?? null;
    if (!raw || typeof raw !== 'object' || (raw as Record<string, unknown>).type !== 'ScriptBlock') {
      ctx.emitError('Measure-Command requires a script block, e.g. Measure-Command { ... }');
      return makeTimeSpan(0);
    }
    const start = simulationNowMs();
    ctx.invokeBlock(raw as PSScriptBlock);
    return makeTimeSpan(simulationNowMs() - start);
  }
}

// ─── Start-Sleep ──────────────────────────────────────────────────────────

export class StartSleepCmdlet implements ICmdlet {
  readonly name = 'start-sleep';
  readonly aliases = ['sleep'] as const;
  readonly parameters = ['Milliseconds', 'Seconds'] as const;
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
