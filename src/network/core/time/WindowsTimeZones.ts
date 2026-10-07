import { TimeZone } from './TimeZone';
import { isDaylightSavingAt, standardOffsetMinutes } from './TimeZoneRegistry';

export interface WindowsTimeZone {
  readonly id: string;
  readonly iana: string;
  readonly nom: string;
}

export const WINDOWS_TIME_ZONES: ReadonlyArray<WindowsTimeZone> = [
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

export function windowsZoneNameAt(iana: string, atMs: number): string {
  const zone = WINDOWS_TIME_ZONES.find((z) => z.iana === iana) ?? WINDOWS_TIME_ZONES[0];
  if (zone.id === 'UTC') return 'Coordinated Universal Time';
  const parsed = TimeZone.parse(zone.iana);
  return parsed !== null && isDaylightSavingAt(parsed, atMs)
    ? zone.id.replace(/Standard Time$/, 'Daylight Time')
    : zone.id;
}

export function windowsZoneById(id: string): WindowsTimeZone | undefined {
  return WINDOWS_TIME_ZONES.find((z) => z.id.toLowerCase() === id.toLowerCase());
}

export function windowsZoneOf(iana: string): WindowsTimeZone {
  return WINDOWS_TIME_ZONES.find((z) => z.iana === iana) ?? WINDOWS_TIME_ZONES[0];
}

export function windowsStandardOffset(zone: WindowsTimeZone, atMs: number): string {
  const parsed = TimeZone.parse(zone.iana);
  const minutes = parsed === null ? 0 : standardOffsetMinutes(parsed, atMs);
  const abs = Math.abs(minutes);
  return `${minutes < 0 ? '-' : '+'}${String(Math.floor(abs / 60)).padStart(2, '0')}:${String(abs % 60).padStart(2, '0')}`;
}

export function windowsZoneDisplayName(zone: WindowsTimeZone, atMs: number): string {
  return `(UTC${windowsStandardOffset(zone, atMs)}) ${zone.nom}`;
}
