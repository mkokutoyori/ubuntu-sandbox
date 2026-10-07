import {
  WINDOWS_TIME_ZONES, windowsZoneById, windowsZoneDisplayName, windowsZoneOf,
} from '@/network/core/time/WindowsTimeZones';

export interface TzutilHost {
  readonly timezone: () => string;
  readonly setTimezone: (iana: string) => void;
  readonly nowMs: () => number;
}

export interface TzutilResult {
  readonly output: string;
  readonly exitCode: number;
}

const USAGE_HINT = 'Use TZUTIL /? for a list of valid options.';

function listZones(host: TzutilHost): string {
  const now = host.nowMs();
  return WINDOWS_TIME_ZONES
    .map((zone) => `${windowsZoneDisplayName(zone, now)}\n${zone.id}\n`)
    .join('\n');
}

export function cmdTzutil(host: TzutilHost, args: string[]): TzutilResult {
  const option = (args[0] ?? '').toLowerCase();
  if (option === '/g' && args.length === 1) return { output: windowsZoneOf(host.timezone()).id, exitCode: 0 };
  if (option === '/l' && args.length === 1) return { output: listZones(host), exitCode: 0 };
  if (option === '/s') {
    if (args.length !== 2) {
      return { output: `TZUTIL: Invalid number of arguments for /s.\n${USAGE_HINT}`, exitCode: 1 };
    }
    const zone = windowsZoneById(args[1]);
    if (zone === undefined) {
      return { output: `TZUTIL: Invalid time zone ${args[1]}.\nUse TZUTIL /l for a list of valid time zones.`, exitCode: 1 };
    }
    host.setTimezone(zone.iana);
    return { output: '', exitCode: 0 };
  }
  return { output: USAGE_HINT, exitCode: 1 };
}
