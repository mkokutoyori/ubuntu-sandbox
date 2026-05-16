/**
 * Pure utility functions used across the RMAN module.
 * Every function is referentially transparent (except generatePieceName
 * which uses Math.random; its output prefix is still deterministic).
 */

import type { RmanTag } from '../values/RmanTag';

/** Format a duration in ms as HH:MM:SS. */
export function formatElapsed(ms: number): string {
  const s = Math.floor(ms / 1000);
  const hh = Math.floor(s / 3600);
  const mm = Math.floor((s % 3600) / 60);
  const ss = s % 60;
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(hh)}:${pad(mm)}:${pad(ss)}`;
}

/** Format a byte count as "B" / "K" / "M" / "G". */
export function formatSize(bytes: number): string {
  if (bytes >= 1_073_741_824) return `${(bytes / 1_073_741_824).toFixed(2)}G`;
  if (bytes >= 1_048_576)     return `${(bytes / 1_048_576).toFixed(2)}M`;
  if (bytes >= 1_024)         return `${(bytes / 1_024).toFixed(2)}K`;
  return `${bytes}B`;
}

/** Generate an Oracle-style backup piece filename. */
export function generatePieceName(dbName: string, _tag: RmanTag): string {
  const rand = Math.random().toString(36).slice(2, 10);
  return `/u01/backup/${dbName}_${rand}.bkp`;
}

/** DD-MON-YYYY HH:MM:SS — the format RMAN prints. */
export function formatOracleDate(d: Date = new Date()): string {
  const months = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(d.getDate())}-${months[d.getMonth()]}-${d.getFullYear()} `
       + `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}
