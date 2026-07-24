export interface MboxEntry {
  readonly envelopeFrom: string;
  readonly receivedAt: number;
  readonly rawMessage: string;
}

export interface MailDropFileSystem {
  exists(path: string): boolean;
  readFile(path: string): string | null;
  writeFile(path: string, content: string, uid: number, gid: number, umask: number, append?: boolean): boolean;
}

const CRLF = '\r\n';

export function splitAddress(address: string): readonly [string, string] {
  const at = address.indexOf('@');
  return at === -1 ? [address, ''] : [address.slice(0, at), address.slice(at + 1)];
}

export function addressesEqualStrict(a: string, b: string): boolean {
  const [aLocal, aDomain] = splitAddress(a);
  const [bLocal, bDomain] = splitAddress(b);
  return aLocal === bLocal && aDomain.toLowerCase() === bDomain.toLowerCase();
}

export function addressesEqualPragmatic(a: string, b: string): boolean {
  const [aLocal, aDomain] = splitAddress(a);
  const [bLocal, bDomain] = splitAddress(b);
  return aLocal.toLowerCase() === bLocal.toLowerCase() && aDomain.toLowerCase() === bDomain.toLowerCase();
}

export function resolveLocalPart(address: string): string {
  return splitAddress(address)[0].toLowerCase();
}

export function mailboxPathFor(address: string): string {
  return `/var/mail/${resolveLocalPart(address)}`;
}

export function mboxFromLine(envelopeFrom: string, receivedAt: number): string {
  const from = envelopeFrom === '' ? 'MAILER-DAEMON' : envelopeFrom;
  return `From ${from} ${new Date(receivedAt).toUTCString()}`;
}

export function formatMboxEntry(entry: MboxEntry): string {
  return `${mboxFromLine(entry.envelopeFrom, entry.receivedAt)}${CRLF}${entry.rawMessage}${CRLF}${CRLF}`;
}

export function deliverLocalMessage(
  fs: MailDropFileSystem,
  recipientAddress: string,
  entry: MboxEntry,
  owner: { uid: number; gid: number },
): boolean {
  const path = mailboxPathFor(recipientAddress);
  return fs.writeFile(path, formatMboxEntry(entry), owner.uid, owner.gid, 0o022, true);
}
