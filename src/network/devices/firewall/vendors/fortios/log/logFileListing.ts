import type { Firewall } from '../../../Firewall';
import type { LogDiskFile } from '../../../logging/LogDisk';
import { WEEKDAYS } from '../diag/timeCommands';

const MONTHS: readonly string[] = Object.freeze([
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
]);

export function formatLogFileStamp(fw: Firewall, at: number): string {
  const local = new Date(fw.localTimeOf(at));
  const time = [local.getUTCHours(), local.getUTCMinutes(), local.getUTCSeconds()]
    .map(part => String(part).padStart(2, '0')).join(':');
  return `${WEEKDAYS[local.getUTCDay()]} ${MONTHS[local.getUTCMonth()]}`
    + ` ${local.getUTCDate()} ${time} ${local.getUTCFullYear()}`;
}

export function renderLogListing(
  fw: Firewall, files: readonly LogDiskFile[], categoryName: string,
): string {
  const lines = files.map(
    file => `${file.name} ${file.bytes} ${formatLogFileStamp(fw, file.at)}`);
  lines.push(`${files.length} ${categoryName} log file(s) found.`);
  return lines.join('\n');
}
