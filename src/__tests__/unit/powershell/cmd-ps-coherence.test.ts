/**
 * A cmd command and its PowerShell equivalent must produce results with
 * the same MEANING. These guard incoherences found by auditing the
 * coherence-* debug transcript pairs:
 *
 *  1. cmd had NO `&&` / `||` / `&` chaining → `cd <dir> && cd` failed
 *     ("cannot find the path") even though the dir existed.
 *  2. `dir /b` ignored the bare flag (printed the full table) → not
 *     coherent with PowerShell `Get-ChildItem -Name`.
 *  3. `vol` and `dir` reported DIFFERENT volume serials for the same
 *     drive (two unrelated serial sources).
 *  4. `netsh ... add address "Ethernet" <ip> <mask>` worked positionally
 *     but `delete address "Ethernet" <ip>` rejected the same form, so
 *     the IP was never removed and Get-NetIPAddress still showed it.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { WindowsPC } from '@/network/devices/WindowsPC';
import { PowerShellSubShell } from '@/terminal/subshells/PowerShellSubShell';
import { resetCounters } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  Logger.reset();
});

function pc(host = 'WIN-COH') {
  const d = new WindowsPC('windows-pc', host);
  d.setCurrentUser('Administrator');
  return d;
}
const ps = (d: WindowsPC) => PowerShellSubShell.create(d).subShell;
const run = async (sh: ReturnType<typeof ps>, l: string) =>
  (await sh.processLine(l)).output.join('\n');

describe('cmd command chaining (&&, ||, &)', () => {
  it('`cd <dir> && cd` enters the dir then prints it', async () => {
    const d = pc();
    await d.executeCmdCommand('mkdir C:\\Demo');
    await d.executeCmdCommand('mkdir C:\\Demo\\fromPS');
    expect(await d.executeCmdCommand('cd C:\\Demo\\fromPS && cd'))
      .toBe('C:\\Demo\\fromPS');
  });

  it('`&&` skips the second command when the first fails', async () => {
    const out = await pc().executeCmdCommand('cd C:\\NoSuchDir && echo SHOULD-NOT-PRINT');
    expect(out).not.toContain('SHOULD-NOT-PRINT');
    expect(out.toLowerCase()).toContain('cannot find the path');
  });

  it('`||` runs the fallback only when the first fails', async () => {
    const out = await pc().executeCmdCommand('cd C:\\NoSuchDir || echo fallback');
    expect(out).toContain('fallback');
  });

  it('`&` always runs both', async () => {
    expect(await pc().executeCmdCommand('echo one & echo two')).toBe('one\ntwo');
  });

  it('operators inside double quotes are literal', async () => {
    expect(await pc().executeCmdCommand('echo "a && b"')).toBe('a && b');
  });
});

describe('`dir /b` ≡ PowerShell `Get-ChildItem -Name`', () => {
  it('bare listing is just the names, same order as gci -Name', async () => {
    const d = pc();
    await d.executeCmdCommand('mkdir C:\\X');
    await d.executeCmdCommand('mkdir C:\\X\\sub');
    await d.executeCmdCommand('echo a > C:\\X\\a.txt');
    await d.executeCmdCommand('echo b > C:\\X\\b.txt');
    const bare = (await d.executeCmdCommand('dir C:\\X /b')).split('\n');
    const gci = (await run(ps(d), 'Get-ChildItem C:\\X -Name')).split('\n');
    expect(bare).toEqual(gci);
    expect(bare).not.toContain(''); // no blank/header/summary lines
    expect(bare.join('\n')).not.toContain('<DIR>');
    expect(bare.join('\n')).not.toContain('Volume');
  });

  it('`dir /s /b` lists full absolute paths recursively', async () => {
    const d = pc();
    await d.executeCmdCommand('mkdir C:\\Y');
    await d.executeCmdCommand('mkdir C:\\Y\\sub');
    await d.executeCmdCommand('echo z > C:\\Y\\z.txt');
    const out = await d.executeCmdCommand('dir C:\\Y /s /b');
    expect(out).toContain('C:\\Y\\sub');
    expect(out).toContain('C:\\Y\\z.txt');
  });
});

describe('`vol` and `dir` agree on the volume serial', () => {
  it('same machine → identical serial; different machines → different', async () => {
    const a = pc('WIN-A');
    const serialVia = (s: string) => s.match(/Serial Number is (\S+)/)?.[1];
    const volA = serialVia(await a.executeCmdCommand('vol C:'));
    const dirA = serialVia(await a.executeCmdCommand('dir C:\\'));
    expect(volA).toBeTruthy();
    expect(volA).toBe(dirA);

    const b = pc('SRV-B');
    const volB = serialVia(await b.executeCmdCommand('vol C:'));
    expect(volB).not.toBe(volA);
    // reproducible for the same host
    expect(serialVia(await pc('WIN-A').executeCmdCommand('vol C:'))).toBe(volA);
  });
});

describe('netsh add/delete address round-trips coherently with PS', () => {
  it('positional delete removes what positional add created', async () => {
    const d = pc();
    const sh = ps(d);
    expect(await d.executeCmdCommand(
      'netsh interface ipv4 add address "Ethernet" 192.168.50.10 255.255.255.0')).toBe('Ok.');
    expect(await run(sh,
      'Get-NetIPAddress | Where-Object { $_.IPAddress -eq "192.168.50.10" }'))
      .toContain('192.168.50.10');

    expect(await d.executeCmdCommand(
      'netsh interface ipv4 delete address "Ethernet" 192.168.50.10')).toBe('Ok.');
    expect(await run(sh,
      'Get-NetIPAddress | Where-Object { $_.IPAddress -eq "192.168.50.10" }'))
      .not.toContain('192.168.50.10');
  });
});

describe('`ver` reports the same OS version in cmd and PowerShell', () => {
  it('cmd ver === PS ver (and matches systeminfo build 22631)', async () => {
    const d = pc();
    const cmdVer = (await d.executeCmdCommand('ver')).trim();
    const psVer = (await run(ps(d), 'ver')).trim();
    expect(cmdVer).toContain('10.0.22631.6649');
    expect(psVer).toContain('10.0.22631.6649');
    expect(psVer.replace(/\s+/g, ' ')).toBe(cmdVer.replace(/\s+/g, ' '));
    expect(await d.executeCmdCommand('systeminfo')).toContain('22631');
  });
});

describe('`echo %VAR%` keeps each shell faithful', () => {
  it('cmd expands %VAR%; PowerShell echoes the literal token', async () => {
    const d = pc('WIN-ECHO');
    expect(await d.executeCmdCommand('echo %COMPUTERNAME%')).toBe('WIN-ECHO');
    const sh = ps(d);
    expect((await sh.processLine('echo %COMPUTERNAME%')).output).toEqual(['%COMPUTERNAME%']);
    expect((await sh.processLine('echo %PATH%')).output).toEqual(['%PATH%']);
    // The `%` change must not break modulo or the ForEach-Object alias.
    expect((await sh.processLine('17 % 5')).output).toEqual(['2']);
    expect((await sh.processLine('1,2,3 | % { $_ * 10 }')).output).toEqual(['10', '20', '30']);
  });
});

describe('`sc` service control is coherent in cmd and PowerShell', () => {
  it('sc query / sc.exe query / sc qc match cmd', async () => {
    const d = pc();
    const sh = ps(d);
    const norm = (s: string) => s.replace(/\s+/g, ' ').trim();

    const cmdQ = await d.executeCmdCommand('sc query Spooler');
    expect(norm(cmdQ)).toContain('SERVICE_NAME: Spooler');
    expect(norm(cmdQ)).toContain('RUNNING');

    expect(norm(await run(sh, 'sc query Spooler'))).toBe(norm(cmdQ));
    expect(norm(await run(sh, 'sc.exe query Spooler'))).toBe(norm(cmdQ));

    const cmdQc = await d.executeCmdCommand('sc qc Spooler');
    expect(norm(await run(sh, 'sc qc Spooler'))).toBe(norm(cmdQc));
    expect(norm(cmdQc)).toContain('AUTO_START');
  });
});
