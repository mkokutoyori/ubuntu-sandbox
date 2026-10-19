import { padToWidth } from '@/network/devices/shells/cli/TextTable';
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

export function formatLoginDate(d: Date): string {
  const dow = DAYS[d.getDay()];
  const mon = MONTHS[d.getMonth()];
  const day = padToWidth(d.getDate().toString(), 2, 'right');
  const hh = d.getHours().toString().padStart(2, '0');
  const mm = d.getMinutes().toString().padStart(2, '0');
  const ss = d.getSeconds().toString().padStart(2, '0');
  return `${dow} ${mon} ${day} ${hh}:${mm}:${ss} ${d.getFullYear()}`;
}
