import { TimeZone } from '../../../../../core/time/TimeZone';

export interface FortiTimezone {
  readonly index: number;
  readonly name: string;
  readonly label: string;
}

export const FORTIOS_TIMEZONES: readonly FortiTimezone[] = Object.freeze([
  { index: 0, name: 'Etc/GMT+11', label: '(GMT-11:00) Midway Island, Samoa' },
  { index: 1, name: 'Pacific/Honolulu', label: '(GMT-10:00) Hawaii' },
  { index: 2, name: 'America/Anchorage', label: '(GMT-9:00) Alaska' },
  { index: 3, name: 'America/Los_Angeles', label: '(GMT-8:00) Pacific Time (US & Canada)' },
  { index: 4, name: 'Europe/Paris', label: '(GMT+1:00) Brussels, Copenhagen, Madrid, Paris' },
  { index: 12, name: 'America/New_York', label: '(GMT-5:00) Eastern Time (US & Canada)' },
  { index: 26, name: 'Europe/London', label: '(GMT) Greenwich Mean Time, London' },
  { index: 27, name: 'UTC', label: '(GMT) Monrovia, Casablanca' },
]);

const BY_INDEX = new Map(FORTIOS_TIMEZONES.map(zone => [zone.index, zone]));
const BY_NAME = new Map(FORTIOS_TIMEZONES.map(zone => [zone.name.toLowerCase(), zone]));

export const HIGHEST_FORTI_INDEX = 86;

export function implementedFortiIndexes(): string {
  return FORTIOS_TIMEZONES.map((zone) => zone.index).sort((a, b) => a - b).join(', ');
}

export function unimplementedFortiIndexes(): Record<string, string> {
  const reason = `this simulator implements only indexes ${implementedFortiIndexes()},`
    + ' and any other zone is reachable by its IANA name, as in'
    + ' `set timezone Europe/Paris`.';
  const entries: Array<[string, string]> = [];
  for (let index = 0; index <= HIGHEST_FORTI_INDEX; index++) {
    if (!BY_INDEX.has(index)) entries.push([String(index), reason]);
  }
  return Object.fromEntries(entries);
}

export function resolveFortiTimezone(raw: string): FortiTimezone | null {
  const value = raw.trim();
  if (value.length === 0) return null;

  if (/^\d+$/.test(value)) {
    return BY_INDEX.get(Number.parseInt(value, 10)) ?? null;
  }

  const known = BY_NAME.get(value.toLowerCase());
  if (known) return known;
  if (!TimeZone.isValid(value)) return null;
  return { index: -1, name: value, label: value };
}
