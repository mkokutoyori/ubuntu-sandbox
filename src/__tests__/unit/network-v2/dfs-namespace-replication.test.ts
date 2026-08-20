/**
 * DFS Namespaces + DFSR — PRD-Windows-Server-Advanced.md §5 P16, §2.1.15.
 * `New-DfsnRoot`/`New-DfsnFolder` build a logical namespace redirecting to
 * real `smbShares` targets (§5 P3, already delivered); `New-
 * DfsReplicationGroup`/`Sync-DfsReplicationGroup` reuse the exact same
 * USN/high-watermark pull mechanism as AD replication (§5 P4) — real TCP
 * traffic on port 5722, not a shortcut — applied to file metadata
 * instead of directory objects.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { resetCounters, IPAddress, SubnetMask } from '@/network/core/types';
import { WindowsServer } from '@/network/devices/WindowsServer';
import { GenericSwitch } from '@/network/devices/GenericSwitch';
import { Cable } from '@/network/hardware/Cable';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { PowerShellSubShell } from '@/terminal/subshells/PowerShellSubShell';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  Logger.reset();
});

const ps = (d: WindowsServer) => PowerShellSubShell.create(d).subShell;
const run = async (sh: ReturnType<typeof ps>, l: string) => (await sh.processLine(l)).output.join('\n');

async function buildLan() {
  const nsServer = new WindowsServer('NS1');
  const target1 = new WindowsServer('TGT1');
  const target2 = new WindowsServer('TGT2');
  const sw = new GenericSwitch('switch-generic', 'SW1');
  new Cable('c-ns').connect(nsServer.getPorts()[0], sw.getPorts()[0]);
  new Cable('c-t1').connect(target1.getPorts()[0], sw.getPorts()[1]);
  new Cable('c-t2').connect(target2.getPorts()[0], sw.getPorts()[2]);
  const mask = new SubnetMask('255.255.255.0');
  nsServer.getPorts()[0].configureIP(new IPAddress('192.168.90.10'), mask);
  target1.getPorts()[0].configureIP(new IPAddress('192.168.90.20'), mask);
  target2.getPorts()[0].configureIP(new IPAddress('192.168.90.21'), mask);
  for (const s of [nsServer, target1, target2]) s.setCurrentUser('Administrator');
  return { nsServer, target1, target2 };
}

describe('DFS Namespaces (§5 P16)', () => {
  it('rejects DFSN cmdlets before FS-DFS-Namespace is installed', async () => {
    const { nsServer } = await buildLan();
    const out = await run(ps(nsServer), 'New-DfsnRoot -Path \\\\lab.local\\Public');
    expect(out).toMatch(/not recognized/i);
  });

  it('a logical namespace folder redirects to the correct smbShares targets on two distinct servers', async () => {
    const { nsServer, target1, target2 } = await buildLan();
    await run(ps(target1), 'New-SmbShare -Name Data -Path C:\\DfsData');
    await run(ps(target2), 'New-SmbShare -Name Data -Path C:\\DfsData');

    await run(ps(nsServer), 'Install-WindowsFeature FS-DFS-Namespace');
    await run(ps(nsServer), 'New-DfsnRoot -Path \\\\lab.local\\Public');
    await run(ps(nsServer), 'New-DfsnFolder -Path \\\\lab.local\\Public\\Data -TargetPath \\\\192.168.90.20\\Data');
    await run(ps(nsServer), 'New-DfsnFolderTarget -Path \\\\lab.local\\Public\\Data -TargetPath \\\\192.168.90.21\\Data');

    const out = await run(ps(nsServer), 'Get-DfsnFolder -Path \\\\lab.local\\Public\\Data | Select-Object -ExpandProperty TargetPaths');
    expect(out).toContain('\\\\192.168.90.20\\Data');
    expect(out).toContain('\\\\192.168.90.21\\Data');
  });

  it('rejects a folder referencing a namespace root that does not exist', async () => {
    const { nsServer } = await buildLan();
    await run(ps(nsServer), 'Install-WindowsFeature FS-DFS-Namespace');
    const out = await run(ps(nsServer), 'New-DfsnFolder -Path \\\\lab.local\\Ghost\\Data -TargetPath \\\\192.168.90.20\\Data');
    expect(out).toMatch(/does not exist/);
  });
});

describe('DFSR (§5 P16) — same USN/high-watermark patron as AD replication (§5 P4)', () => {
  it('a write on one target propagates to the other after a real TCP/5722 sync cycle', async () => {
    const { target1, target2 } = await buildLan();
    await run(ps(target1), 'Install-WindowsFeature FS-DFS-Replication');
    await run(ps(target2), 'Install-WindowsFeature FS-DFS-Replication');
    await run(ps(target1), 'New-DfsReplicationGroup -GroupName RG1 -ContentPath C:\\DfsData');
    await run(ps(target2), 'New-DfsReplicationGroup -GroupName RG1 -ContentPath C:\\DfsData');

    // A write on target1 (simulating a client-visible change on that target).
    target1.getFileSystem().mkdirp('C:\\DfsData');
    target1.getFileSystem().createFile('C:\\DfsData\\report.txt', 'quarterly numbers v1');

    const syncOut = await run(ps(target2), 'Sync-DfsReplicationGroup -GroupName RG1 -PartnerServer 192.168.90.20 | Select-Object -ExpandProperty FilesApplied');
    expect(Number(syncOut.trim())).toBeGreaterThanOrEqual(1);

    const converged = target2.getFileSystem().readFile('C:\\DfsData\\report.txt');
    expect(converged.ok).toBe(true);
    expect(converged.content).toBe('quarterly numbers v1');
  });

  it('an unchanged file is not re-transferred on a second sync (only the delta propagates)', async () => {
    const { target1, target2 } = await buildLan();
    await run(ps(target1), 'Install-WindowsFeature FS-DFS-Replication');
    await run(ps(target2), 'Install-WindowsFeature FS-DFS-Replication');
    await run(ps(target1), 'New-DfsReplicationGroup -GroupName RG1 -ContentPath C:\\DfsData');
    await run(ps(target2), 'New-DfsReplicationGroup -GroupName RG1 -ContentPath C:\\DfsData');

    target1.getFileSystem().mkdirp('C:\\DfsData');
    target1.getFileSystem().createFile('C:\\DfsData\\report.txt', 'v1');
    await run(ps(target2), 'Sync-DfsReplicationGroup -GroupName RG1 -PartnerServer 192.168.90.20');

    const secondSync = await run(ps(target2), 'Sync-DfsReplicationGroup -GroupName RG1 -PartnerServer 192.168.90.20 | Select-Object -ExpandProperty FilesApplied');
    expect(Number(secondSync.trim())).toBe(0);
  });

  it('rejects syncing a replication group that does not exist', async () => {
    const { target1, target2 } = await buildLan();
    await run(ps(target2), 'Install-WindowsFeature FS-DFS-Replication');
    const out = await run(ps(target2), 'Sync-DfsReplicationGroup -GroupName Ghost -PartnerServer 192.168.90.20');
    expect(out).toMatch(/does not exist/);
  });
});
