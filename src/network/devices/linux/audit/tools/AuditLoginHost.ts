import type { AuditSearchHost } from './AuditToolHost';

export interface PasswdEntry {
  name: string;
  uid: number;
}

export interface AuditLoginHost extends AuditSearchHost {
  uid(): number;
  passwdEntries(): PasswdEntry[];
}

export type AuditLogSource =
  | { kind: 'texts'; texts: string[] }
  | { kind: 'error'; stderr: string; message: string };

export function resolveLogSource(host: AuditLoginHost, input: { file: string | null; stdin: string | null; useStdin: boolean }): AuditLogSource {
  if (input.file !== null) {
    const text = host.readFile(input.file);
    return text === null ? { kind: 'error', stderr: '', message: 'No such file or directory' } : { kind: 'texts', texts: [text] };
  }
  if (input.useStdin) return { kind: 'texts', texts: [input.stdin ?? ''] };
  const config = host.auditConfig();
  const base = config?.logFile ?? '/var/log/audit/audit.log';
  const found: string[] = [];
  let num = 0;
  let filename = base;
  while (host.readFile(filename) !== null) {
    found.push(filename);
    num++;
    filename = `${base}.${num}`;
  }
  if (found.length === 0) return { kind: 'error', stderr: 'No log file\n', message: 'No such file or directory' };
  const texts = found.map((name) => host.readFile(name) ?? '').reverse();
  return { kind: 'texts', texts };
}
