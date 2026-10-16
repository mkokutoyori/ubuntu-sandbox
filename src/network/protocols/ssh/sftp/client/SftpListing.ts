const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const HALF_YEAR_MS = (365 * 24 * 60 * 60 / 2) * 1000;
const SCALE_UNITS = ['', 'K', 'M', 'G', 'T', 'P', 'E'];

export function strmode(mode: number): string {
  const type = (mode & 0o170000);
  const kind = type === 0o040000 ? 'd' : type === 0o120000 ? 'l' : type === 0o020000 ? 'c'
    : type === 0o060000 ? 'b' : type === 0o010000 ? 'p' : type === 0o140000 ? 's' : '-';
  const bit = (mask: number, letter: string): string => ((mode & mask) !== 0 ? letter : '-');
  const execute = (mask: number, special: number, lower: string, upper: string): string => {
    const set = (mode & mask) !== 0;
    if ((mode & special) === 0) return set ? 'x' : '-';
    return set ? lower : upper;
  };
  return kind
    + bit(0o400, 'r') + bit(0o200, 'w') + execute(0o100, 0o4000, 's', 'S')
    + bit(0o040, 'r') + bit(0o020, 'w') + execute(0o010, 0o2000, 's', 'S')
    + bit(0o004, 'r') + bit(0o002, 'w') + execute(0o001, 0o1000, 't', 'T');
}

export function scaledSize(bytes: number): string {
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < SCALE_UNITS.length - 1) {
    value /= 1024;
    unit++;
  }
  if (unit === 0) return String(bytes);
  const rounded = value < 10 ? (Math.round(value * 10) / 10).toFixed(1) : String(Math.round(value));
  return `${rounded}${SCALE_UNITS[unit]}`;
}

export function listingTime(mtimeMs: number, nowMs: number, zoneOffsetMinutes = 0): string {
  const when = new Date(mtimeMs + zoneOffsetMinutes * 60_000);
  const month = MONTHS[when.getUTCMonth()];
  const day = String(when.getUTCDate()).padStart(2, ' ');
  if (nowMs - HALF_YEAR_MS < mtimeMs && nowMs >= mtimeMs) {
    return `${month} ${day} ${String(when.getUTCHours()).padStart(2, '0')}:${String(when.getUTCMinutes()).padStart(2, '0')}`;
  }
  return `${month} ${day}  ${when.getUTCFullYear()}`;
}

export interface ListingEntry {
  readonly mode: number;
  readonly uid: number;
  readonly gid: number;
  readonly size: number;
  readonly mtimeMs: number;
}

export interface ListingNames {
  readonly user: string;
  readonly group: string;
  readonly links: string;
}

export function formatListing(
  name: string, entry: ListingEntry, names: ListingNames | 'remote', nowMs: number, siUnits: boolean, zoneOffsetMinutes = 0,
): string {
  const resolved: ListingNames = names === 'remote'
    ? { user: String(entry.uid), group: String(entry.gid), links: '?' }
    : names;
  const userWidth = Math.max(resolved.user.length, 8);
  const groupWidth = Math.max(resolved.group.length, 8);
  const size = siUnits ? scaledSize(entry.size).padStart(8, ' ') : String(entry.size).padStart(8, ' ');
  return `${strmode(entry.mode)} ${resolved.links.padStart(3, ' ')} ${resolved.user.padEnd(userWidth, ' ')} ${resolved.group.padEnd(groupWidth, ' ')} ${size} ${listingTime(entry.mtimeMs, nowMs, zoneOffsetMinutes)} ${name}`;
}
