/**
 * UtmpBinaryFormat — fixed-width on-disk encoding for /var/run/utmp,
 * /var/log/wtmp and /var/log/btmp.
 *
 * Real glibc `struct utmp` is exactly 384 bytes; tools like `wc -c` /
 * `stat -c '%s'` divided by 384 are a standard way to estimate entry
 * counts without a parser. Storing these files as JSON (as this
 * simulator used to) makes that arithmetic meaningless. This packs each
 * record into a delimited, null-padded 384-character block instead —
 * not a byte-exact reimplementation of the real C struct layout, but
 * size-faithful, which is what every consumer of the file (`last`,
 * `wc -c`, manual `stat` math) actually depends on.
 */

import type { UtmpRecord, BtmpRecord } from './UtmpSync';

export const UTMP_RECORD_SIZE = 384;
const SEP = '\x1f';

function packBlock(fields: string[]): string {
  const body = fields.join(SEP);
  if (body.length >= UTMP_RECORD_SIZE) return body.slice(0, UTMP_RECORD_SIZE);
  return body + '\0'.repeat(UTMP_RECORD_SIZE - body.length);
}

export function packUtmpRecord(r: UtmpRecord): string {
  return packBlock([
    r.user, r.tty, r.fromIp, r.fromHost ?? '',
    String(r.loginAt), r.closedAt != null ? String(r.closedAt) : '',
    String(r.shellPid ?? 0), String(r.sshdPid ?? 0), String(r.uid ?? 0),
  ]);
}

export function unpackUtmpRecord(block: string): UtmpRecord {
  const body = block.replace(/\0+$/, '');
  const [user, tty, fromIp, fromHost, loginAt, closedAt, shellPid, sshdPid, uid] = body.split(SEP);
  return {
    user: user ?? '', tty: tty ?? '', fromIp: fromIp ?? '',
    fromHost: fromHost || undefined,
    loginAt: Number(loginAt) || 0,
    closedAt: closedAt ? Number(closedAt) : null,
    shellPid: Number(shellPid) || undefined,
    sshdPid: Number(sshdPid) || undefined,
    uid: Number(uid) || undefined,
  };
}

export function packBtmpRecord(r: BtmpRecord): string {
  return packBlock([r.user, r.tty, r.fromIp, String(r.at)]);
}

export function unpackBtmpRecord(block: string): BtmpRecord {
  const body = block.replace(/\0+$/, '');
  const [user, tty, fromIp, at] = body.split(SEP);
  return { user: user ?? '', tty: tty ?? '', fromIp: fromIp ?? '', at: Number(at) || 0 };
}

export function encodeUtmpFile(records: UtmpRecord[]): string {
  return records.map(packUtmpRecord).join('');
}

export function encodeBtmpFile(records: BtmpRecord[]): string {
  return records.map(packBtmpRecord).join('');
}

function splitBlocks(raw: string): string[] {
  const blocks: string[] = [];
  for (let i = 0; i + UTMP_RECORD_SIZE <= raw.length; i += UTMP_RECORD_SIZE) {
    blocks.push(raw.slice(i, i + UTMP_RECORD_SIZE));
  }
  return blocks;
}

export function decodeUtmpFile(raw: string): UtmpRecord[] {
  return splitBlocks(raw).map(unpackUtmpRecord);
}

export function decodeBtmpFile(raw: string): BtmpRecord[] {
  return splitBlocks(raw).map(unpackBtmpRecord);
}
