export const AUDIT_UNSET = 4294967295;

export type AuditFieldMap = Record<string, string | number>;

export interface AuditSender {
  pid: number;
  uid: number;
  auid: number;
  ses: number;
}

export interface AcctMessage {
  op: string;
  name: string | null;
  id: number | null;
  exe: string;
  tty: string | null;
  success: boolean;
}

export function needsEncoding(value: string): boolean {
  for (const byte of new TextEncoder().encode(value)) {
    if (byte === 0x22 || byte < 0x21 || byte > 0x7e) return true;
  }
  return false;
}

export function encodeValue(value: string): string {
  return [...new TextEncoder().encode(value)].map((b) => b.toString(16).toUpperCase().padStart(2, '0')).join('');
}

export function acctMessageBody(m: AcctMessage): string {
  const exe = `"${m.exe}"`;
  const tail = `exe=${exe} hostname=? addr=? terminal=${m.tty ?? '?'} res=${m.success ? 'success' : 'failed'}`;
  if (m.name !== null && m.id === null) {
    const acct = needsEncoding(m.name) ? encodeValue(m.name) : `"${m.name}"`;
    return `op=${m.op} acct=${acct} ${tail}`;
  }
  return `op=${m.op} id=${(m.id ?? AUDIT_UNSET) >>> 0} ${tail}`;
}

export function userMessageFields(sender: AuditSender, body: string): AuditFieldMap {
  return { pid: sender.pid, uid: sender.uid, auid: sender.auid, ses: sender.ses, subj: 'unconfined', msg: body };
}

export function acctMessageFields(sender: AuditSender, m: AcctMessage): AuditFieldMap {
  return userMessageFields(sender, acctMessageBody(m));
}

export function ttyForAudit(tty: string): string {
  return tty.replace(/^\/dev\//, '');
}

export function grantorsOf(results: ReadonlyArray<{ module: string; code: number }>): string {
  const names = results.filter((r) => r.code === 0).map((r) => r.module.replace(/^.*\//, '').replace(/\.so$/, ''));
  return names.length > 0 ? names.join(',') : '?';
}
