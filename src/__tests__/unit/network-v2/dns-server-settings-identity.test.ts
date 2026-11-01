/*
 * Structure — what the DNS role reports about the machine behind it: the computer name, the version and build, whether
 * the directory is there (which decides BootMethod: 3 from the directory, 2 from the registry for a standalone server),
 * read-only domain controller or not, and the addresses it listens on. The identity is handed to the role by the machine;
 * the settings table only renders it. Discrimination (run on the tree before the change): every case falls, the role had
 * no settings table.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { resetCounters } from '@/network/core/types';
import { WindowsServer } from '@/network/devices/WindowsServer';
import { WindowsDnsServerRole } from '@/network/devices/windows/server/dns/WindowsDnsServerRole';
import type { DnsServerIdentity } from '@/network/devices/windows/server/dns/DnsServerSettings';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';

beforeEach(() => { resetCounters(); resetDeviceCounters(); Logger.clear(); });

const valueOf = (role: WindowsDnsServerRole, property: string) => role.getServerSettings().find((entry) => entry.property === property)?.value;

const IDENTITY: DnsServerIdentity = {
  computerName: 'dc1.corp.test', majorVersion: 10, minorVersion: 0, buildNumber: 20348, isReadOnlyDc: true,
  directoryAvailable: true, addresses: ['10.0.1.10', '10.0.2.10'],
};

describe('the machine behind the DNS role', () => {
  it('is rendered from the identity the machine hands over', () => {
    const role = new WindowsDnsServerRole(new WindowsServer('DC1'), { identity: () => IDENTITY });
    expect(valueOf(role, 'ComputerName')).toBe('dc1.corp.test');
    expect(valueOf(role, 'BuildNumber')).toBe(20348);
    expect(valueOf(role, 'IsReadOnlyDC')).toBe(true);
    expect(valueOf(role, 'ListeningIPAddress')).toEqual(['10.0.1.10', '10.0.2.10']);
  });

  it('boots from the directory when it is there and from the registry when it is not', () => {
    const withDirectory = new WindowsDnsServerRole(new WindowsServer('DC1'), { identity: () => IDENTITY });
    const standalone = new WindowsDnsServerRole(new WindowsServer('SRV1'), { identity: () => ({ ...IDENTITY, directoryAvailable: false }) });
    expect(valueOf(withDirectory, 'DsAvailable')).toBe(true);
    expect(valueOf(withDirectory, 'BootMethod')).toBe(3);
    expect(valueOf(standalone, 'DsAvailable')).toBe(false);
    expect(valueOf(standalone, 'BootMethod')).toBe(2);
  });

  it('a boot method written to the registry wins over the one the directory implies', () => {
    const role = new WindowsDnsServerRole(new WindowsServer('DC1'), { identity: () => IDENTITY });
    expect(role.setServerSettings(new Map([['BootMethod', 1]])).ok).toBe(true);
    expect(valueOf(role, 'BootMethod')).toBe(1);
  });
});
