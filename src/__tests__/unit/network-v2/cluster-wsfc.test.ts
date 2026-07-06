/**
 * Failover Clustering / WSFC minimal — PRD-Windows-Server-Advanced.md §5
 * P18, §2.1.17, MS-CMRP. `New-Cluster` forms a cluster identically on each
 * `WindowsServer` node; real periodic UDP heartbeat traffic (port 3343)
 * between nodes drives quorum (simple majority, no witness disk) and
 * `Get-ClusterGroup`'s File Server failover — no shared cluster object, no
 * central mediator, mirroring DFSR's own per-node membership convention
 * (§5 P16).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { resetCounters, IPAddress, SubnetMask } from '@/network/core/types';
import { WindowsServer } from '@/network/devices/WindowsServer';
import { GenericSwitch } from '@/network/devices/GenericSwitch';
import { Cable } from '@/network/hardware/Cable';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { PowerShellSubShell } from '@/terminal/subshells/PowerShellSubShell';
import { VirtualTimeScheduler, __setDefaultScheduler } from '@/events/Scheduler';
import { MISSED_THRESHOLD_MS } from '@/network/devices/windows/server/cluster/ClusterService';

let scheduler: VirtualTimeScheduler;

beforeEach(() => {
  scheduler = new VirtualTimeScheduler();
  __setDefaultScheduler(scheduler);
  resetCounters();
  resetDeviceCounters();
  Logger.reset();
});

afterEach(() => {
  __setDefaultScheduler(null);
});

const ps = (d: WindowsServer) => PowerShellSubShell.create(d).subShell;
const run = async (sh: ReturnType<typeof ps>, l: string) => (await sh.processLine(l)).output.join('\n');

function buildLan() {
  const srv1 = new WindowsServer('SRV1');
  const srv2 = new WindowsServer('SRV2');
  const sw = new GenericSwitch('switch-generic', 'SW1');
  const c1 = new Cable('c1');
  const c2 = new Cable('c2');
  c1.connect(srv1.getPorts()[0], sw.getPorts()[0]);
  c2.connect(srv2.getPorts()[0], sw.getPorts()[1]);
  const mask = new SubnetMask('255.255.255.0');
  srv1.getPorts()[0].configureIP(new IPAddress('192.168.96.10'), mask);
  srv2.getPorts()[0].configureIP(new IPAddress('192.168.96.20'), mask);
  srv1.setCurrentUser('Administrator');
  srv2.setCurrentUser('Administrator');
  return { srv1, srv2, c2 };
}

async function formCluster(srv1: WindowsServer, srv2: WindowsServer): Promise<void> {
  await run(ps(srv1), 'Install-WindowsFeature Failover-Clustering');
  await run(ps(srv2), 'Install-WindowsFeature Failover-Clustering');
  await run(ps(srv1), 'New-Cluster -Name CLUS1 -Node SRV1,SRV2 -NodeAddress 192.168.96.10,192.168.96.20');
  await run(ps(srv2), 'New-Cluster -Name CLUS1 -Node SRV2,SRV1 -NodeAddress 192.168.96.20,192.168.96.10');
}

describe('WSFC clustering (§5 P18)', () => {
  it('New-Cluster is refused before the Failover-Clustering feature is installed', async () => {
    const { srv1 } = buildLan();
    const out = await run(ps(srv1), 'New-Cluster -Name CLUS1 -Node SRV1,SRV2 -NodeAddress 192.168.96.10,192.168.96.20');
    expect(out).toMatch(/not recognized/);
  });

  it('two nodes form a cluster and each sees the other as Up via real UDP heartbeat', async () => {
    const { srv1, srv2 } = buildLan();
    await formCluster(srv1, srv2);

    const nodesOut = await run(ps(srv1), 'Get-ClusterNode | Format-Table -HideTableHeaders NodeName,State');
    expect(nodesOut).toContain('SRV1');
    expect(nodesOut).toContain('SRV2');
    expect(nodesOut).not.toContain('Down');

    const quorumOut = await run(ps(srv1), 'Get-Cluster | Select-Object -ExpandProperty HasQuorum');
    expect(quorumOut.trim()).toBe('True');
  });

  it('a simulated node loss (dropped heartbeat) fails the File Server role over to the survivor, visible via Get-ClusterGroup', async () => {
    const { srv1, srv2, c2 } = buildLan();
    await formCluster(srv1, srv2);

    // SRV2 is the current preferred (and thus active) owner; SRV1 is the backup.
    await run(ps(srv1), 'Add-ClusterFileServerRole -Name FS1 -Node SRV2,SRV1');
    await run(ps(srv2), 'Add-ClusterFileServerRole -Name FS1 -Node SRV2,SRV1');

    const before = await run(ps(srv1), 'Get-ClusterGroup -Name FS1 | Select-Object -ExpandProperty OwnerNode');
    expect(before.trim()).toBe('SRV2');

    // Simulated node loss: SRV2 goes silent (link down) — no more heartbeats reach SRV1.
    c2.disconnect();
    scheduler.advance(MISSED_THRESHOLD_MS + 1000);

    const nodesOut = await run(ps(srv1), 'Get-ClusterNode | Format-Table -HideTableHeaders NodeName,State');
    expect(nodesOut).toMatch(/SRV2\s+Down/);

    const after = await run(ps(srv1), 'Get-ClusterGroup -Name FS1 | Select-Object -ExpandProperty OwnerNode');
    expect(after.trim()).toBe('SRV1');
  });

  it('a 2-node cluster loses quorum once only one node remains reachable (no witness disk)', async () => {
    const { srv1, srv2, c2 } = buildLan();
    await formCluster(srv1, srv2);

    c2.disconnect();
    scheduler.advance(MISSED_THRESHOLD_MS + 1000);

    const quorumOut = await run(ps(srv1), 'Get-Cluster | Select-Object -ExpandProperty HasQuorum');
    expect(quorumOut.trim()).toBe('False');
  });

  it('Move-ClusterGroup manually reassigns ownership to a currently-up node', async () => {
    const { srv1, srv2 } = buildLan();
    await formCluster(srv1, srv2);
    await run(ps(srv1), 'Add-ClusterFileServerRole -Name FS1 -Node SRV1,SRV2');

    const before = await run(ps(srv1), 'Get-ClusterGroup -Name FS1 | Select-Object -ExpandProperty OwnerNode');
    expect(before.trim()).toBe('SRV1');

    await run(ps(srv1), 'Move-ClusterGroup -Name FS1 -Node SRV2');
    const after = await run(ps(srv1), 'Get-ClusterGroup -Name FS1 | Select-Object -ExpandProperty OwnerNode');
    expect(after.trim()).toBe('SRV2');
  });
});
