import { describe, it, expect, beforeEach } from 'vitest';
import { WindowsPC } from '@/network/devices/WindowsPC';
import { WindowsServer } from '@/network/devices/WindowsServer';
import { resetCounters } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
});

async function gcm(device: WindowsPC): Promise<string> {
  return device.executeCommand('powershell -Command "Get-Command | Select-Object -ExpandProperty Name"');
}

describe('Windows Server cmdlets are not visible on a Windows PC', () => {
  it('Get-Command on a PC lists no Server-role cmdlets', async () => {
    const pc = new WindowsPC('windows-pc', 'PC1', 0, 0);
    const out = await gcm(pc);
    for (const forbidden of [
      /DhcpServer/i, /DnsServer/i, /WindowsFeature/i,
      /\bAdUser\b/i, /\bAdGroup\b/i, /\bAddomain\b/i, /Addsforest/i,
      /Cluster/i, /WsusUpdate/i, /\bGpo\b/i, /Website/i, /Dfsn/i,
      /NpsRadius/i, /RduserSession/i,
    ]) {
      expect(out).not.toMatch(forbidden);
    }
  });

  it('invoking a Server cmdlet on a PC fails as an unknown command', async () => {
    const pc = new WindowsPC('windows-pc', 'PC1', 0, 0);
    const out = await pc.executeCommand('powershell -Command "Get-ADUser -Filter *"');
    expect(out).toMatch(/not recognized|CommandNotFound/i);
  });

  it('client cmdlets remain available on a PC (SMB, domain join, PKI, printing)', async () => {
    const pc = new WindowsPC('windows-pc', 'PC1', 0, 0);
    const out = await gcm(pc);
    for (const kept of [/Get-Smbshare/i, /Add-Computer/i, /New-Selfsignedcertificate/i, /Add-Printer/i]) {
      expect(out).toMatch(kept);
    }
  });

  it('a Windows Server still exposes the Server-role cmdlets', async () => {
    const srv = new WindowsServer('SRV1', 0, 0);
    const out = await gcm(srv);
    for (const kept of [/Get-Windowsfeature/i, /Get-Aduser/i, /Get-Dhcpserverv4Scope/i, /Add-Dnsserverprimaryzone/i]) {
      expect(out).toMatch(kept);
    }
  });
});
