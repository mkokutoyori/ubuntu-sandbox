export interface LocalTime {
  year: number;
  mon: number;
  mday: number;
  hour: number;
  min: number;
  sec: number;
  wday: number;
  yday: number;
}

export type DateStyle = 'mdy2' | 'mdy4' | 'dmy4';

export interface AuditToolHost {
  readFile(path: string): string | null;
  isDirectory(path: string): boolean;
  userName(uid: number): string | null;
  groupName(gid: number): string | null;
  localTime(epochSec: number): LocalTime;
  mktime(tm: Omit<LocalTime, 'wday' | 'yday'>): number;
  nowSec(): number;
  uptimeSec(): number;
  auditConfig(): { logFile: string; eoeTimeout: number } | null;
  dateStyle(): DateStyle;
}

export class ExitSignal extends Error {
  constructor(readonly code: number) {
    super(`exit ${code}`);
  }
}

export class ToolOutput {
  readonly out: string[] = [];
  readonly err: string[] = [];
  readonly order: string[] = [];

  printf(text: string): void {
    this.out.push(text);
    this.order.push(text);
  }

  eprintf(text: string): void {
    this.err.push(text);
    this.order.push(text);
  }

  get interleaved(): string {
    return this.order.join('');
  }

  get stdout(): string {
    return this.out.join('');
  }

  get stderr(): string {
    return this.err.join('');
  }
}

export interface ToolResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  interleaved: string;
}

const pad2 = (n: number): string => String(n).padStart(2, '0');

export function formatDate(tm: LocalTime, style: DateStyle): string {
  const yy = pad2(((tm.year % 100) + 100) % 100);
  if (style === 'mdy2') return `${pad2(tm.mon + 1)}/${pad2(tm.mday)}/${yy}`;
  if (style === 'mdy4') return `${pad2(tm.mon + 1)}/${pad2(tm.mday)}/${tm.year}`;
  return `${pad2(tm.mday)}/${pad2(tm.mon + 1)}/${tm.year}`;
}

export function formatTime(tm: LocalTime): string {
  return `${pad2(tm.hour)}:${pad2(tm.min)}:${pad2(tm.sec)}`;
}

export function formatDateTime(host: AuditToolHost, epochSec: number): string {
  const tm = host.localTime(epochSec);
  return `${formatDate(tm, host.dateStyle())} ${formatTime(tm)}`;
}
