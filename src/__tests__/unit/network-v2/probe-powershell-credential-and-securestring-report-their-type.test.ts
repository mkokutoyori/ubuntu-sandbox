/*
 * Probe: `$cred.GetType().FullName` and `(ConvertTo-SecureString ...).GetType().FullName` answered
 * System.Collections.Hashtable, because both values are modelled as plain records. PowerShell answers
 * System.Management.Automation.PSCredential and System.Security.SecureString (PSCredential and SecureString class pages,
 * Microsoft Learn), and `$cred.Password.GetType()` the second.
 *
 * Discriminated with git stash on src: 4 of 5 fall before the fix; one passes either way and is named: the witness
 * (a plain string still reports System.String).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { resetCounters, MACAddress } from '@/network/core/types';
import { WindowsPC } from '@/network/devices/WindowsPC';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { PowerShellSubShell } from '@/terminal/subshells/PowerShellSubShell';

beforeEach(() => { resetCounters(); resetDeviceCounters(); MACAddress.resetCounter(); Logger.reset(); });

function shell() {
  const pc = new WindowsPC('windows-pc', 'PC1', 0, 0);
  pc.powerOn();
  const sh = PowerShellSubShell.create(pc).subShell;
  return async (line: string) => (await sh.processLine(line)).output.join('\n').trim();
}

const SECRET = '(ConvertTo-SecureString "p" -AsPlainText -Force)';

describe('GetType of credentials and secure strings', () => {
  it('witness: a string is a System.String', async () => {
    expect(await shell()('"a".GetType().FullName')).toBe('System.String');
  });

  it('New-Object PSCredential is a PSCredential', async () => {
    expect(await shell()(`(New-Object PSCredential("u", ${SECRET})).GetType().FullName`)).toBe('System.Management.Automation.PSCredential');
  });

  it('[pscredential]::new is the same type', async () => {
    expect(await shell()(`([pscredential]::new("u", ${SECRET})).GetType().Name`)).toBe('PSCredential');
  });

  it('ConvertTo-SecureString answers a SecureString', async () => {
    expect(await shell()(`${SECRET}.GetType().FullName`)).toBe('System.Security.SecureString');
  });

  it('the Password of a credential is a SecureString', async () => {
    expect(await shell()(`(New-Object PSCredential("u", ${SECRET})).Password.GetType().FullName`)).toBe('System.Security.SecureString');
  });
});
