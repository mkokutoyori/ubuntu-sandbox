import type { LocalTime } from './AuditToolHost';

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const pad2 = (n: number): string => String(n).padStart(2, '0');

export function formatCtime(tm: LocalTime): string {
  return `${DAYS[tm.wday]} ${MONTHS[tm.mon]} ${String(tm.mday).padStart(2, ' ')} ${pad2(tm.hour)}:${pad2(tm.min)}:${pad2(tm.sec)} ${tm.year}\n`;
}
