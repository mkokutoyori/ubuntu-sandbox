/**
 * `msDS-SupportedEncryptionTypes` — previously completely unmodeled.
 * `KdcSession`'s AS-REQ path now refuses to issue a ticket to a principal
 * (user or computer) restricted away from AES256, since that's the only
 * cipher this simulator's Kerberos actually implements (`crypto.ts`).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { resetCounters, IPAddress, SubnetMask } from '@/network/core/types';
import { DirectoryStore } from '@/network/devices/windows/server/ad/DirectoryStore';
import { WindowsServer } from '@/network/devices/WindowsServer';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { GenericSwitch } from '@/network/devices/GenericSwitch';
import { Cable } from '@/network/hardware/Cable';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { PowerShellSubShell } from '@/terminal/subshells/PowerShellSubShell';
import { dialKdc } from '@/network/kerberos/KerberosClient';
import { KrbErrorCode } from '@/network/kerberos/types';

function store(): DirectoryStore { return new DirectoryStore('lab.local', 'LAB', 'P@ssw0rd'); }

describe('DirectoryStore — msDS-SupportedEncryptionTypes', () => {
  it('defaults to RC4+AES128+AES256 (0x1C) when never explicitly set', () => {
    const s = store();
    s.newUser('alice', { password: 'alicepw' });
    expect(s.getUser('alice')!.supportedEncryptionTypes).toBe(0x1c);
    s.newComputer('WKS1', 'secret1');
    expect(s.getComputer('WKS1')!.supportedEncryptionTypes).toBe(0x1c);
  });

  it('setUserSupportedEncryptionTypes updates the projected value', () => {
    const s = store();
    s.newUser('alice', { password: 'alicepw' });
    expect(s.setUserSupportedEncryptionTypes('alice', 0x4).ok).toBe(true);
    expect(s.getUser('alice')!.supportedEncryptionTypes).toBe(0x4);
  });

  it('setComputerSupportedEncryptionTypes updates the projected value', () => {
    const s = store();
    s.newComputer('WKS1', 'secret1');
    expect(s.setComputerSupportedEncryptionTypes('WKS1', 0x8).ok).toBe(true);
    expect(s.getComputer('WKS1')!.supportedEncryptionTypes).toBe(0x8);
  });

  it('fails with a not-found message for an unknown identity', () => {
    const s = store();
    expect(s.setUserSupportedEncryptionTypes('nosuchuser', 0x10).ok).toBe(false);
    expect(s.setComputerSupportedEncryptionTypes('NOSUCHPC', 0x10).ok).toBe(false);
  });

  it('supportsAes256 reflects the AES256 bit for both users and computers', () => {
    const s = store();
    s.newUser('alice', { password: 'alicepw' });
    s.newComputer('WKS1', 'secret1');
    expect(s.supportsAes256('alice', false)).toBe(true);
    expect(s.supportsAes256('WKS1', true)).toBe(true);
    s.setUserSupportedEncryptionTypes('alice', 0x4);
    s.setComputerSupportedEncryptionTypes('WKS1', 0x4);
    expect(s.supportsAes256('alice', false)).toBe(false);
    expect(s.supportsAes256('WKS1', true)).toBe(false);
  });

  it('an explicit 0 (no supported types) is distinct from "unset" and disables AES256', () => {
    const s = store();
    s.newUser('alice', { password: 'alicepw' });
    s.setUserSupportedEncryptionTypes('alice', 0);
    expect(s.getUser('alice')!.supportedEncryptionTypes).toBe(0);
    expect(s.supportsAes256('alice', false)).toBe(false);
  });
});

describe('Kerberos AS exchange — msDS-SupportedEncryptionTypes enforcement over a real TCP/88 wire', () => {
  beforeEach(() => {
    resetCounters();
    resetDeviceCounters();
    Logger.reset();
  });

  const ps = (d: WindowsServer) => PowerShellSubShell.create(d).subShell;
  const run = async (sh: ReturnType<typeof ps>, l: string) => (await sh.processLine(l)).output.join('\n');

  async function buildLan(): Promise<{ dc: WindowsServer; client: LinuxServer }> {
    const dc = new WindowsServer('DC1');
    const client = new LinuxServer('linux-server', 'CLIENT1');
    const sw = new GenericSwitch('switch-generic', 'SW1');
    new Cable('c-dc').connect(dc.getPorts()[0], sw.getPorts()[0]);
    new Cable('c-client').connect(client.getPorts()[0], sw.getPorts()[1]);
    const mask = new SubnetMask('255.255.255.0');
    dc.getPorts()[0].configureIP(new IPAddress('192.168.55.10'), mask);
    client.getPorts()[0].configureIP(new IPAddress('192.168.55.20'), mask);

    dc.setCurrentUser('Administrator');
    await run(ps(dc), 'Install-WindowsFeature AD-Domain-Services');
    await run(ps(dc), 'Install-ADDSForest -DomainName lab.local -SafeModeAdministratorPassword (ConvertTo-SecureString "P@ssw0rd" -AsPlainText -Force)');
    await run(ps(dc), 'New-ADUser -Name alice -AccountPassword (ConvertTo-SecureString "alicepw" -AsPlainText -Force) -DisplayName "Alice"');
    return { dc, client };
  }

  it('still completes the AS exchange for an unrestricted (default) account', async () => {
    const { dc, client } = await buildLan();
    expect(dc.getDirectoryStore()!.getUser('alice')!.supportedEncryptionTypes).toBe(0x1c);
    const conn = dialKdc(client.getTcpStack(), '192.168.55.10');
    const result = conn.client!.asExchange('alice', 'alicepw', 'LAB.LOCAL');
    expect(result.ok).toBe(true);
  });

  it('refuses an AS-REQ with KDC_ERR_ETYPE_NOSUPP once the account is restricted away from AES256', async () => {
    const { dc, client } = await buildLan();
    dc.getDirectoryStore()!.setUserSupportedEncryptionTypes('alice', 0x4); // RC4 only
    const conn = dialKdc(client.getTcpStack(), '192.168.55.10');
    const result = conn.client!.asExchange('alice', 'alicepw', 'LAB.LOCAL');
    expect(result.ok).toBe(false);
    expect(result.errorCode).toBe(KrbErrorCode.KDC_ERR_ETYPE_NOSUPP);
  });

  it('restores a successful AS exchange once AES256 is re-enabled', async () => {
    const { dc, client } = await buildLan();
    dc.getDirectoryStore()!.setUserSupportedEncryptionTypes('alice', 0x4);
    dc.getDirectoryStore()!.setUserSupportedEncryptionTypes('alice', 0x10);
    const conn = dialKdc(client.getTcpStack(), '192.168.55.10');
    const result = conn.client!.asExchange('alice', 'alicepw', 'LAB.LOCAL');
    expect(result.ok).toBe(true);
  });
});
