/**
 * PRD-Windows-Server-Advanced.md §5 P23 — observability transverse to §5
 * P13-P22: `WindowsAdcsRole`/`RdpSessionTable`/`ClusterService`/
 * `WindowsDfsrRole` publish `adcs.*`/`rdp.*`/`cluster.*`/`dfs.*` events and
 * feed their own signal stores, mirroring the §5 P12 convention
 * (`kerberos.*`/`replication.*`).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { resetCounters, IPAddress, SubnetMask } from '@/network/core/types';
import { WindowsServer } from '@/network/devices/WindowsServer';
import { GenericSwitch } from '@/network/devices/GenericSwitch';
import { Cable } from '@/network/hardware/Cable';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { PowerShellSubShell } from '@/terminal/subshells/PowerShellSubShell';
import { CertificateVerifier } from '@/network/pki/CertificateVerifier';
import { EventBus, __setDefaultEventBus } from '@/events/EventBus';
import { VirtualTimeScheduler, __setDefaultScheduler } from '@/events/Scheduler';
import { MISSED_THRESHOLD_MS } from '@/network/devices/windows/server/cluster/ClusterService';
import type { AdcsDomainEvent } from '@/network/devices/windows/server/adcs/events';
import type { RdpDomainEvent } from '@/network/devices/windows/server/rdp/events';
import type { ClusterDomainEvent } from '@/network/devices/windows/server/cluster/events';
import type { DfsDomainEvent } from '@/network/devices/windows/server/dfs/events';

let bus: EventBus;
let scheduler: VirtualTimeScheduler;

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  Logger.reset();
  bus = new EventBus();
  __setDefaultEventBus(bus);
  scheduler = new VirtualTimeScheduler();
  __setDefaultScheduler(scheduler);
});

afterEach(() => {
  __setDefaultEventBus(null);
  __setDefaultScheduler(null);
});

const ps = (d: WindowsServer) => PowerShellSubShell.create(d).subShell;
const run = async (sh: ReturnType<typeof ps>, l: string) => (await sh.processLine(l)).output.join('\n');

function collect<T extends { topic: string }>(
  publisher: WindowsServer, topic: T['topic'],
): unknown[] {
  const out: unknown[] = [];
  publisher.getBus().subscribe(topic as never, (e: { payload: unknown }) => out.push(e.payload));
  return out;
}

describe('AD CS observability (§5 P23)', () => {
  it('publishes adcs.certificate.issued and records it in the signal store', async () => {
    const dc = new WindowsServer('CA1');
    dc.setCurrentUser('Administrator');
    const events = collect<AdcsDomainEvent>(dc, 'adcs.certificate.issued');

    await run(ps(dc), 'Install-WindowsFeature AD-Certificate');
    await run(ps(dc), 'Install-AdcsCertificationAuthority -CACommonName "Lab Root CA"');
    await run(ps(dc), 'Get-Certificate -Template WebServer -DnsName www.lab.local');

    expect(events.length).toBe(1);
    expect(events[0]).toMatchObject({ deviceId: 'CA1', templateName: 'WebServer' });
    expect(dc.getAdcsSignals().stats.get().certificatesIssued).toBe(1);
  });
});

describe('RDP observability (§5 P23)', () => {
  it('publishes rdp.session.established/closed and records them in the signal store', async () => {
    const server = new WindowsServer('SRV1');
    const client = new WindowsServer('CLIENT1');
    const sw = new GenericSwitch('switch-generic', 'SW1');
    new Cable('c1').connect(server.getPorts()[0], sw.getPorts()[0]);
    new Cable('c2').connect(client.getPorts()[0], sw.getPorts()[1]);
    const mask = new SubnetMask('255.255.255.0');
    server.getPorts()[0].configureIP(new IPAddress('192.168.99.10'), mask);
    client.getPorts()[0].configureIP(new IPAddress('192.168.99.20'), mask);
    server.setCurrentUser('Administrator');

    const established = collect<RdpDomainEvent>(server, 'rdp.session.established');
    const closed = collect<RdpDomainEvent>(server, 'rdp.session.closed');

    await run(ps(server), 'Enable-RemoteDesktop');
    const verifier = new CertificateVerifier({ trustAnchors: [server.getRdpTlsCertificate()] });
    const result = client.dialRdp('192.168.99.10', 'bob', 'bob', verifier);
    expect(result.ok).toBe(true);

    expect(established.length).toBe(1);
    expect(established[0]).toMatchObject({ deviceId: 'SRV1', userName: 'bob' });
    expect(server.getRdpSignals().stats.get().sessionsEstablished).toBe(1);

    await server.executeCmdCommand(`logoff ${result.sessionId}`);
    expect(closed.length).toBe(1);
    expect(server.getRdpSignals().stats.get().sessionsClosed).toBe(1);
  });
});

describe('DFSR observability (§5 P23)', () => {
  it('publishes dfs.replication.synced and records it in the signal store', async () => {
    const target1 = new WindowsServer('DFS1');
    const target2 = new WindowsServer('DFS2');
    const sw = new GenericSwitch('switch-generic', 'SW1');
    new Cable('c1').connect(target1.getPorts()[0], sw.getPorts()[0]);
    new Cable('c2').connect(target2.getPorts()[0], sw.getPorts()[1]);
    const mask = new SubnetMask('255.255.255.0');
    target1.getPorts()[0].configureIP(new IPAddress('192.168.99.30'), mask);
    target2.getPorts()[0].configureIP(new IPAddress('192.168.99.31'), mask);
    target1.setCurrentUser('Administrator');
    target2.setCurrentUser('Administrator');

    await run(ps(target1), 'Install-WindowsFeature FS-DFS-Replication');
    await run(ps(target2), 'Install-WindowsFeature FS-DFS-Replication');
    await run(ps(target1), 'New-DfsReplicationGroup -GroupName RG1 -ContentPath C:\\DfsData');
    await run(ps(target2), 'New-DfsReplicationGroup -GroupName RG1 -ContentPath C:\\DfsData');
    target1.getFileSystem().mkdirp('C:\\DfsData');
    target1.getFileSystem().createFile('C:\\DfsData\\report.txt', 'quarterly numbers v1');

    const synced = collect<DfsDomainEvent>(target2, 'dfs.replication.synced');
    await run(ps(target2), 'Sync-DfsReplicationGroup -GroupName RG1 -PartnerServer 192.168.99.30');

    expect(synced.length).toBe(1);
    expect(synced[0]).toMatchObject({ deviceId: 'DFS2', groupName: 'RG1' });
    expect(target2.getDfsSignals().stats.get().syncsCompleted).toBe(1);
  });
});

describe('WSFC cluster observability (§5 P23)', () => {
  it('publishes cluster.node.down and cluster.group.moved on simulated node loss', async () => {
    const srv1 = new WindowsServer('SRV1');
    const srv2 = new WindowsServer('SRV2');
    const sw = new GenericSwitch('switch-generic', 'SW1');
    const c1 = new Cable('c1');
    const c2 = new Cable('c2');
    c1.connect(srv1.getPorts()[0], sw.getPorts()[0]);
    c2.connect(srv2.getPorts()[0], sw.getPorts()[1]);
    const mask = new SubnetMask('255.255.255.0');
    srv1.getPorts()[0].configureIP(new IPAddress('192.168.99.40'), mask);
    srv2.getPorts()[0].configureIP(new IPAddress('192.168.99.41'), mask);
    srv1.setCurrentUser('Administrator');
    srv2.setCurrentUser('Administrator');

    await run(ps(srv1), 'Install-WindowsFeature Failover-Clustering');
    await run(ps(srv2), 'Install-WindowsFeature Failover-Clustering');
    await run(ps(srv1), 'New-Cluster -Name CLUS1 -Node SRV1,SRV2 -NodeAddress 192.168.99.40,192.168.99.41');
    await run(ps(srv2), 'New-Cluster -Name CLUS1 -Node SRV2,SRV1 -NodeAddress 192.168.99.41,192.168.99.40');
    await run(ps(srv1), 'Add-ClusterFileServerRole -Name FS1 -Node SRV2,SRV1');

    const nodeDown = collect<ClusterDomainEvent>(srv1, 'cluster.node.down');
    const groupMoved = collect<ClusterDomainEvent>(srv1, 'cluster.group.moved');

    c2.disconnect();
    scheduler.advance(MISSED_THRESHOLD_MS + 1000);

    expect(nodeDown.length).toBeGreaterThanOrEqual(1);
    expect(nodeDown[0]).toMatchObject({ deviceId: 'SRV1', clusterName: 'CLUS1', nodeName: 'SRV2' });
    expect(groupMoved.length).toBeGreaterThanOrEqual(1);
    expect(groupMoved[0]).toMatchObject({ groupName: 'FS1', toNode: 'SRV1' });
    expect(srv1.getClusterSignals().stats.get().nodeDownTransitions).toBeGreaterThanOrEqual(1);
    expect(srv1.getClusterSignals().stats.get().groupMoves).toBeGreaterThanOrEqual(1);
  });

  it('publishes cluster.group.moved on a manual Move-ClusterGroup', async () => {
    const srv1 = new WindowsServer('SRV1');
    const srv2 = new WindowsServer('SRV2');
    const sw = new GenericSwitch('switch-generic', 'SW1');
    new Cable('c1').connect(srv1.getPorts()[0], sw.getPorts()[0]);
    new Cable('c2').connect(srv2.getPorts()[0], sw.getPorts()[1]);
    const mask = new SubnetMask('255.255.255.0');
    srv1.getPorts()[0].configureIP(new IPAddress('192.168.99.50'), mask);
    srv2.getPorts()[0].configureIP(new IPAddress('192.168.99.51'), mask);
    srv1.setCurrentUser('Administrator');
    srv2.setCurrentUser('Administrator');

    await run(ps(srv1), 'Install-WindowsFeature Failover-Clustering');
    await run(ps(srv2), 'Install-WindowsFeature Failover-Clustering');
    await run(ps(srv1), 'New-Cluster -Name CLUS1 -Node SRV1,SRV2 -NodeAddress 192.168.99.50,192.168.99.51');
    await run(ps(srv2), 'New-Cluster -Name CLUS1 -Node SRV2,SRV1 -NodeAddress 192.168.99.51,192.168.99.50');
    await run(ps(srv1), 'Add-ClusterFileServerRole -Name FS1 -Node SRV1,SRV2');

    const groupMoved = collect<ClusterDomainEvent>(srv1, 'cluster.group.moved');
    await run(ps(srv1), 'Move-ClusterGroup -Name FS1 -Node SRV2');

    expect(groupMoved.length).toBe(1);
    expect(groupMoved[0]).toMatchObject({ groupName: 'FS1', fromNode: 'SRV1', toNode: 'SRV2' });
  });
});
