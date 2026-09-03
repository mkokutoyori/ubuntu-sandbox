import type { Firewall } from '../../../Firewall';
import { FortiMessages } from '../FortiMessages';

const TIME_OF_DAY = /^([01]\d|2[0-3]):([0-5]\d):([0-5]\d)$/;
const CALENDAR_DAY = /^(\d{4})-(\d{2})-(\d{2})$/;

function twoDigits(value: number): string {
  return String(value).padStart(2, '0');
}

export function localClockText(fw: Firewall): string {
  const local = new Date(fw.localNow());
  return `${twoDigits(local.getUTCHours())}:${twoDigits(local.getUTCMinutes())}`
    + `:${twoDigits(local.getUTCSeconds())}`;
}

export function localDateText(fw: Firewall): string {
  const local = new Date(fw.localNow());
  return `${local.getUTCFullYear()}-${twoDigits(local.getUTCMonth() + 1)}`
    + `-${twoDigits(local.getUTCDate())}`;
}

export const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = [
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
];

export function fortiSystemTime(fw: Firewall): string {
  const local = new Date(fw.localNow());
  return `${WEEKDAYS[local.getUTCDay()]} ${MONTHS[local.getUTCMonth()]}`
    + ` ${String(local.getUTCDate()).padStart(2, ' ')} ${localClockText(fw)}`
    + ` ${local.getUTCFullYear()}`;
}

export function runExecuteTime(rest: readonly string[], fw: Firewall): string {
  if (rest.length === 0) return `current time is: ${localClockText(fw)}`;

  const parsed = TIME_OF_DAY.exec(rest[0]);
  if (!parsed) return FortiMessages.valueError(rest[0], 'expected <hh:mm:ss>.');

  const local = new Date(fw.localNow());
  fw.setLocalClock(Date.UTC(
    local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate(),
    Number(parsed[1]), Number(parsed[2]), Number(parsed[3]),
  ));
  return `current time is: ${localClockText(fw)}`;
}

export function runExecuteDate(rest: readonly string[], fw: Firewall): string {
  if (rest.length === 0) return `current date is: ${localDateText(fw)}`;

  const parsed = CALENDAR_DAY.exec(rest[0]);
  if (!parsed) return FortiMessages.valueError(rest[0], 'expected <yyyy-mm-dd>.');

  const month = Number(parsed[2]);
  const day = Number(parsed[3]);
  if (month < 1 || month > 12 || day < 1 || day > 31) {
    return FortiMessages.valueError(rest[0], 'expected <yyyy-mm-dd>.');
  }

  const local = new Date(fw.localNow());
  fw.setLocalClock(Date.UTC(
    Number(parsed[1]), month - 1, day,
    local.getUTCHours(), local.getUTCMinutes(), local.getUTCSeconds(),
  ));
  return `current date is: ${localDateText(fw)}`;
}
