import { abreviationA, decalageA } from '../time/TimezoneDatabase';
import type { PamLocalTime } from './PamLinuxHost';

export function localTimeIn(zone: string, epochMs: number): PamLocalTime {
  const shifted = new Date(epochMs + decalageA(zone, epochMs) * 60_000);
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth(),
    day: shifted.getUTCDate(),
    weekday: shifted.getUTCDay(),
    hour: shifted.getUTCHours(),
    minute: shifted.getUTCMinutes(),
    second: shifted.getUTCSeconds(),
    abbreviation: abreviationA(zone, epochMs),
  };
}
