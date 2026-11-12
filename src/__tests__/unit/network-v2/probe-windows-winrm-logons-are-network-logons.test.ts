/**
 * Probe: a logon made over WinRM is journalled as a network logon, with the client's details.
 *
 * Reference (rule 8): Microsoft's security auditing reference, event 4624 (learn.microsoft.com, previous-versions windows-10
 * security/threat-protection/auditing/event-4624): LogonType 3 is a network logon; NTLM carries LogonProcessName, AuthenticationPackageName,
 * LmPackageName and KeyLength, Kerberos carries a package of its own and a key length of 0; WorkstationName, IpAddress and IpPort name the client.
 * The SMB server was aligned first (probe-windows-smb-logons-are-network-logons); the WinRM server had the same defect.
 *
 * Measured before the change: WinRmServerHandler checked the password with the default logon type (2, interactive) and no details, so a
 * correct logon was journalled as an interactive one with no client address, a wrong password was journalled as type 2 too, and an unknown
 * account was not journalled at all (the check was skipped when the account did not exist). Closing the session wrote no 4634.
 *
 * The probe drives the device's real WinRM handler over a stub stream (the wire path of the client is not involved: its PSCredential plumbing
 * is outside this change), with the real user manager and event log of a WindowsPC.
 *
 * Discrimination (git stash push -- src/network src/powershell): 5 of 6 cases fall on the base. The WITNESS passes either way: the handler
 * accepts the right password and refuses the wrong one.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { WindowsPC } from '@/network/devices/WindowsPC';
import { PowerShellSubShell } from '@/terminal/subshells/PowerShellSubShell';
import type { TcpStream } from '@/network/tcp/types';

class Stream implements TcpStream {
  readonly localIp = '10.0.0.1';
  readonly localPort = 5985;
  readonly remoteIp = '10.0.0.2';
  readonly remotePort = 49152;
  readonly sent: Array<Record<string, unknown>> = [];
  private readonly closers: Array<(reason: string) => void> = [];
  private readonly readers: Array<(data: string) => void> = [];
  write(data: string): void { this.sent.push(JSON.parse(data) as Record<string, unknown>); }
  close(): void { this.drop(); }
  onData(handler: (data: string) => void): () => void { this.readers.push(handler); return () => undefined; }
  onClose(handler: (reason: string) => void): () => void { this.closers.push(handler); return () => undefined; }
  send(message: Record<string, unknown>): void { for (const reader of this.readers) reader(JSON.stringify(message)); }
  drop(): void { for (const closer of this.closers) closer('reset'); }
  get last(): Record<string, unknown> { return this.sent[this.sent.length - 1]; }
}

let pc: WindowsPC;
let ps: (line: string) => Promise<string>;

function client(): Stream {
  const stream = new Stream();
  pc.getWinRmServerHandler().register(stream, '10.0.0.2', 'PC-B');
  return stream;
}

beforeEach(async () => {
  pc = new WindowsPC('windows-pc', 'PC-A', 0, 0);
  pc.setCurrentUser('Administrator');
  const shell = PowerShellSubShell.create(pc).subShell;
  ps = async (line) => (await shell.processLine(line)).output.join('\n');
  await ps('New-LocalUser -Name rmuser -Password (ConvertTo-SecureString "Passw0rd!" -AsPlainText -Force) | Out-Null');
});

const LAST = (id: number): string => `(Get-WinEvent -FilterHashtable @{LogName="Security"; Id=${id}})[0]`;

describe('WinRM logons in the Security log', () => {
  it('WITNESS: the right password is accepted and the wrong one refused', async () => {
    const good = client();
    good.send({ op: 'auth', username: 'rmuser', password: 'Passw0rd!' });
    expect(good.last.ok).toBe(true);
    const bad = client();
    bad.send({ op: 'auth', username: 'rmuser', password: 'nope' });
    expect(bad.last.ok).toBe(false);
  });

  it('a good logon is a type 3 network logon for the account', async () => {
    client().send({ op: 'auth', username: 'rmuser', password: 'Passw0rd!' });
    const xml = await ps(`(Get-WinEvent -FilterHashtable @{LogName="Security"; Id=4624} | Where-Object { $_.Message -match "Logon Type:\\s+3" })[0].ToXml()`);
    expect(xml).toContain("<Data Name='TargetUserName'>rmuser</Data>");
    expect(xml).toContain("<Data Name='LogonType'>3</Data>");
  });

  it('names the machine and the address the logon came from, with the NTLM package', async () => {
    client().send({ op: 'auth', username: 'rmuser', password: 'Passw0rd!' });
    const xml = await ps(`(Get-WinEvent -FilterHashtable @{LogName="Security"; Id=4624} | Where-Object { $_.Message -match "Logon Type:\\s+3" })[0].ToXml()`);
    expect(xml).toContain("<Data Name='WorkstationName'>PC-B</Data>");
    expect(xml).toContain("<Data Name='IpAddress'>10.0.0.2</Data>");
    expect(xml).toContain("<Data Name='AuthenticationPackageName'>NTLM</Data>");
    expect(xml).toContain("<Data Name='LogonProcessName'>NtLmSsp</Data>");
  });

  it('a wrong password writes 4625 of type 3 with the bad-password sub status', async () => {
    client().send({ op: 'auth', username: 'rmuser', password: 'nope' });
    const xml = await ps(`${LAST(4625)}.ToXml()`);
    expect(xml).toContain("<Data Name='LogonType'>3</Data>");
    expect(xml).toContain("<Data Name='SubStatus'>0xC000006A</Data>");
    expect(xml).toContain("<Data Name='IpAddress'>10.0.0.2</Data>");
  });

  it('an unknown account writes 4625 with the unknown-user sub status', async () => {
    client().send({ op: 'auth', username: 'ghost', password: 'Passw0rd!' });
    const xml = await ps(`${LAST(4625)}.ToXml()`);
    expect(xml).toContain("<Data Name='SubStatus'>0xC0000064</Data>");
    expect(xml).toContain("<Data Name='TargetUserName'>ghost</Data>");
  });

  it('closing the session writes 4634 of type 3', async () => {
    const stream = client();
    stream.send({ op: 'auth', username: 'rmuser', password: 'Passw0rd!' });
    stream.drop();
    const xml = await ps(`${LAST(4634)}.ToXml()`);
    expect(xml).toContain("<Data Name='LogonType'>3</Data>");
    expect(xml).toContain("<Data Name='TargetUserName'>rmuser</Data>");
  });
});
