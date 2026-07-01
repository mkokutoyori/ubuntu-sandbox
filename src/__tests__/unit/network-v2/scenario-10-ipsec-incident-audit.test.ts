/**
 * Scénario 10 — Audit et corrélation des logs multi-équipements pour
 * reconstruire chronologiquement un incident VPN.
 *
 * Topologie :
 *
 *   [PC1] -- [R1 IPsec peer] === IPsec ESP === [R2 IPsec peer] -- [PC2]
 *
 * Déroulé de l'incident scripté une seule fois dans `beforeAll` puis
 * inspecté par tous les tests (moins onéreux + garantit que tout le
 * flux d'événements provient bien de la MÊME timeline) :
 *
 *   Phase 1 — établissement nominal via ping PC2 → PC1.
 *   Phase 2 — trafic applicatif normal.
 *   Phase 3 — attaque : ré-injection de trames ESP capturées côté R1.
 *   Phase 4 — rupture : `clear crypto sa` + `clear crypto isakmp` +
 *             shutdown Gi0/1 sur R1 → tunnel démoli, PC1 en timeout.
 *   Phase 5 — rétablissement : `no shutdown` + ping → nouvelle IKE +
 *             nouvelle Phase 2 avec un SPI différent.
 *
 * Points de contrôle vérifiés (couverture 10.A → 10.K) :
 *   - événements attendus à chaque phase ;
 *   - corrélation par clé partagée (peerIp, SPI) entre R1 et R2 ;
 *   - horodatage monotone ;
 *   - filtrage par équipement ET par classe d'événement ;
 *   - le tampon `show logging` du routeur restitue IKE/IPSEC ;
 *   - la coupure PC1 (`host.icmp.echo-timeout`) tombe dans la fenêtre
 *     temporelle de la destruction de la SA côté R1 ;
 *   - la reconstruction chronologique est possible en une passe.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { Cable } from '@/network/hardware/Cable';
import { resetCounters, ETHERTYPE_IPV4, IP_PROTO_ESP, EthernetFrame, IPv4Packet } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import { Logger } from '@/network/core/Logger';
import { getDefaultEventBus } from '@/events/EventBus';
import type { Port } from '@/network/hardware/Port';

type EventRow = {
  timestamp: number;
  topic: string;
  source: string;
  event?: string;
  message?: string;
  payload: Record<string, unknown>;
};

function collectAll(): { rows: EventRow[]; unsub: () => void } {
  const rows: EventRow[] = [];
  const bus = getDefaultEventBus();
  const topics = [
    'log',
    'ipsec.engine.started', 'ipsec.engine.stopped',
    'ipsec.ike.sa-installed', 'ipsec.ike.sa-deleted',
    'ipsec.sa.installed', 'ipsec.sa.deleted',
    'ipsec.inbound.outcome', 'ipsec.outbound.outcome',
    'ipsec.dpd.request-sent', 'ipsec.dpd.peer-down',
    'host.icmp.echo-sent', 'host.icmp.echo-reply',
    'host.icmp.echo-timeout', 'host.icmp.echo-failed',
  ];
  const unsubs: Array<() => void> = [];
  for (const topic of topics) {
    unsubs.push(bus.subscribe(topic, (e) => {
      const p = e.payload as Record<string, unknown>;
      rows.push({
        timestamp: Date.now(),
        topic,
        source: (p.source as string) || (p.deviceId as string) || '',
        event: p.event as string | undefined,
        message: p.message as string | undefined,
        payload: p,
      });
    }));
  }
  return { rows, unsub: () => { for (const u of unsubs) u(); } };
}

interface EspProbe { frames: EthernetFrame[] }

function captureInboundEsp(deviceId: string, portName: string): EspProbe {
  const probe: EspProbe = { frames: [] };
  getDefaultEventBus().subscribe('port.frame.received', (e) => {
    const p = e.payload as { deviceId?: string; portName?: string; frame: EthernetFrame };
    if (p.deviceId !== deviceId || p.portName !== portName) return;
    if (p.frame.etherType !== ETHERTYPE_IPV4) return;
    const ip = p.frame.payload as IPv4Packet | undefined;
    if (!ip || ip.protocol !== IP_PROTO_ESP) return;
    probe.frames.push({ ...p.frame });
  });
  return probe;
}

async function buildTunnel() {
  const r1 = new CiscoRouter('R1');
  const r2 = new CiscoRouter('R2');
  const pc1 = new LinuxPC('linux-pc', 'PC1');
  const pc2 = new LinuxPC('linux-pc', 'PC2');

  new Cable('wan').connect(r1.getPort('GigabitEthernet0/1')!, r2.getPort('GigabitEthernet0/1')!);
  new Cable('lan1').connect(pc1.getPort('eth0')!, r1.getPort('GigabitEthernet0/0')!);
  new Cable('lan2').connect(pc2.getPort('eth0')!, r2.getPort('GigabitEthernet0/0')!);

  for (const [router, outsideIp, insideIp, peerIp, aclSrc, aclDst] of [
    [r1, '10.0.12.1', '192.168.1.1', '10.0.12.2', '192.168.1.0', '192.168.2.0'],
    [r2, '10.0.12.2', '192.168.2.1', '10.0.12.1', '192.168.2.0', '192.168.1.0'],
  ] as [CiscoRouter, string, string, string, string, string][]) {
    (router as unknown as { getLoggingConfig: () => unknown }).getLoggingConfig();
    await router.executeCommand('enable');
    await router.executeCommand('configure terminal');
    await router.executeCommand('interface GigabitEthernet0/1');
    await router.executeCommand(`ip address ${outsideIp} 255.255.255.252`);
    await router.executeCommand('no shutdown');
    await router.executeCommand('exit');
    await router.executeCommand('interface GigabitEthernet0/0');
    await router.executeCommand(`ip address ${insideIp} 255.255.255.0`);
    await router.executeCommand('no shutdown');
    await router.executeCommand('exit');
    await router.executeCommand('crypto isakmp policy 10');
    await router.executeCommand('encryption aes 256');
    await router.executeCommand('hash sha256');
    await router.executeCommand('authentication pre-share');
    await router.executeCommand('group 14');
    await router.executeCommand('exit');
    await router.executeCommand(`crypto isakmp key AuditSecret1 address ${peerIp}`);
    await router.executeCommand('crypto ipsec transform-set TSET esp-aes 256 esp-sha256-hmac');
    await router.executeCommand('mode tunnel');
    await router.executeCommand('exit');
    await router.executeCommand('ip access-list extended VPN_ACL');
    await router.executeCommand(`permit ip ${aclSrc} 0.0.0.255 ${aclDst} 0.0.0.255`);
    await router.executeCommand('exit');
    await router.executeCommand('crypto map CMAP 10 ipsec-isakmp');
    await router.executeCommand(`set peer ${peerIp}`);
    await router.executeCommand('set transform-set TSET');
    await router.executeCommand('match address VPN_ACL');
    await router.executeCommand('exit');
    await router.executeCommand('interface GigabitEthernet0/1');
    await router.executeCommand('crypto map CMAP');
    await router.executeCommand('exit');
    await router.executeCommand(`ip route ${aclDst} 255.255.255.0 ${peerIp}`);
    await router.executeCommand('end');
  }

  await pc1.executeCommand('sudo ip addr add 192.168.1.10/24 dev eth0');
  await pc1.executeCommand('sudo ip route add default via 192.168.1.1');
  await pc2.executeCommand('sudo ip addr add 192.168.2.10/24 dev eth0');
  await pc2.executeCommand('sudo ip route add default via 192.168.2.1');

  return { r1, r2, pc1, pc2 };
}

interface Timeline {
  phase1: number; phase2: number; phase3Start: number; phase3End: number;
  phase4: number; phase5: number;
  replayedFrame: EthernetFrame | null;
}

async function runIncidentTimeline(
  r1: CiscoRouter, r2: CiscoRouter, pc1: LinuxPC, pc2: LinuxPC,
  espProbe: EspProbe,
): Promise<Timeline> {
  const phase1 = Date.now();
  await pc2.executeCommand('ping -c 1 192.168.1.10');

  const phase2 = Date.now();
  await pc2.executeCommand('ping -c 2 192.168.1.10');

  const phase3Start = Date.now();
  const r1WanPort = r1.getPort('GigabitEthernet0/1') as Port;
  const replayedFrame = espProbe.frames[0] ?? null;
  if (replayedFrame) {
    for (let i = 0; i < 4; i++) r1WanPort.receiveFrame(replayedFrame);
  }
  const phase3End = Date.now();

  const phase4 = Date.now();
  await r1.executeCommand('enable');
  await r1.executeCommand('clear crypto sa');
  await r1.executeCommand('clear crypto isakmp');
  await r2.executeCommand('enable');
  await r2.executeCommand('clear crypto sa');
  await r2.executeCommand('clear crypto isakmp');
  await r1.executeCommand('configure terminal');
  await r1.executeCommand('interface GigabitEthernet0/1');
  await r1.executeCommand('shutdown');
  await r1.executeCommand('end');
  await pc1.executeCommand('ping -c 1 -W 1 192.168.2.10');

  const phase5 = Date.now();
  await r1.executeCommand('configure terminal');
  await r1.executeCommand('interface GigabitEthernet0/1');
  await r1.executeCommand('no shutdown');
  await r1.executeCommand('end');
  await pc2.executeCommand('ping -c 3 192.168.1.10');

  void r2;
  return { phase1, phase2, phase3Start, phase3End, phase4, phase5, replayedFrame };
}

interface Fixture {
  r1: CiscoRouter; r2: CiscoRouter; pc1: LinuxPC; pc2: LinuxPC;
  rows: EventRow[];
  timeline: Timeline;
}

describe('Scenario 10 — cross-equipment log audit for incident reconstruction', () => {
  let fixture: Fixture;

  beforeAll(async () => {
    resetCounters();
    resetDeviceCounters();
    Logger.reset();
    EquipmentRegistry.resetInstance();

    const collector = collectAll();
    const { r1, r2, pc1, pc2 } = await buildTunnel();
    const espProbe = captureInboundEsp(r1.getId(), 'GigabitEthernet0/1');
    const timeline = await runIncidentTimeline(r1, r2, pc1, pc2, espProbe);
    collector.unsub();
    fixture = { r1, r2, pc1, pc2, rows: collector.rows, timeline };
  }, 30000);

  describe('10.A — nominal establishment', () => {
    it('records ipsec.ike.sa-installed + ipsec.sa.installed for R1 and R2 correlated by peerIp', () => {
      const ikeR1 = fixture.rows.filter((r) => r.topic === 'ipsec.ike.sa-installed' && r.payload.deviceId === fixture.r1.getId());
      const ikeR2 = fixture.rows.filter((r) => r.topic === 'ipsec.ike.sa-installed' && r.payload.deviceId === fixture.r2.getId());
      expect(ikeR1.length).toBeGreaterThan(0);
      expect(ikeR2.length).toBeGreaterThan(0);
      expect(ikeR1[0].payload.peerIp).toBe('10.0.12.2');
      expect(ikeR2[0].payload.peerIp).toBe('10.0.12.1');

      const ipsecR1 = fixture.rows.find((r) => r.topic === 'ipsec.sa.installed' && r.payload.deviceId === fixture.r1.getId());
      const ipsecR2 = fixture.rows.find((r) => r.topic === 'ipsec.sa.installed' && r.payload.deviceId === fixture.r2.getId());
      expect(ipsecR1).toBeTruthy();
      expect(ipsecR2).toBeTruthy();
    });
  });

  describe('10.B — cross-peer SPI correlation', () => {
    it('R1 inbound SPI equals R2 outbound SPI (and vice versa)', () => {
      const saR1 = fixture.rows.find((r) => r.topic === 'ipsec.sa.installed' && r.payload.deviceId === fixture.r1.getId());
      const saR2 = fixture.rows.find((r) => r.topic === 'ipsec.sa.installed' && r.payload.deviceId === fixture.r2.getId());
      expect(saR1?.payload.spiInbound).toBe(saR2?.payload.spiOutbound);
      expect(saR1?.payload.spiOutbound).toBe(saR2?.payload.spiInbound);
    });
  });

  describe('10.C — anti-replay logs carry the SPI of the R1 inbound SA', () => {
    it('every re-injected ESP frame emits ipsec:anti-replay carrying that same SPI', () => {
      expect(fixture.timeline.replayedFrame).toBeTruthy();
      const saR1 = fixture.rows.find((r) => r.topic === 'ipsec.sa.installed' && r.payload.deviceId === fixture.r1.getId());
      const replayLogs = fixture.rows.filter((r) =>
        r.topic === 'log' && (r.payload as { event?: string }).event === 'ipsec:anti-replay'
        && r.source === fixture.r1.getId());
      expect(replayLogs.length).toBeGreaterThan(0);
      const spiHex = (saR1!.payload.spiInbound as number).toString(16);
      const spiRegex = new RegExp(`spi=0x0*${spiHex}`, 'i');
      for (const row of replayLogs) expect(row.message).toMatch(spiRegex);
    });
  });

  describe('10.D — rupture (clear crypto isakmp + shutdown) fires deletion events', () => {
    it('emits ipsec.ike.sa-deleted on R1 with reason=manual', () => {
      const del = fixture.rows.filter((r) =>
        r.topic === 'ipsec.ike.sa-deleted' && r.payload.deviceId === fixture.r1.getId());
      expect(del.length).toBeGreaterThan(0);
      expect(del[0].payload.reason).toBe('manual');
    });

    it('emits ipsec.sa.deleted on R1 with reason=manual', () => {
      const del = fixture.rows.filter((r) =>
        r.topic === 'ipsec.sa.deleted' && r.payload.deviceId === fixture.r1.getId());
      expect(del.length).toBeGreaterThan(0);
      expect(del[0].payload.reason).toBe('manual');
    });
  });

  describe('10.E — recovery produces a fresh IKE + IPsec install with a new SPI', () => {
    it('the SPI after recovery differs from the one used in phase 1', () => {
      const saR1Installs = fixture.rows.filter((r) =>
        r.topic === 'ipsec.sa.installed' && r.payload.deviceId === fixture.r1.getId());
      expect(saR1Installs.length).toBeGreaterThanOrEqual(2);
      const spiBefore = saR1Installs[0].payload.spiInbound as number;
      const spiAfter = saR1Installs[saR1Installs.length - 1].payload.spiInbound as number;
      expect(spiAfter).not.toBe(spiBefore);
    });
  });

  describe('10.F — chronological ordering', () => {
    it('the incident event stream is monotonically ordered by timestamp', () => {
      for (let i = 1; i < fixture.rows.length; i++) {
        expect(fixture.rows[i].timestamp).toBeGreaterThanOrEqual(fixture.rows[i - 1].timestamp);
      }
    });

    it('the causal chain establish → replay → rupture → recovery appears in order', () => {
      const posEstablish = fixture.rows.findIndex((r) =>
        r.topic === 'ipsec.sa.installed' && r.payload.deviceId === fixture.r1.getId());
      const posReplay = fixture.rows.findIndex((r) =>
        r.topic === 'log' && (r.payload as { event?: string }).event === 'ipsec:anti-replay');
      const posRupture = fixture.rows.findIndex((r) =>
        r.topic === 'ipsec.ike.sa-deleted' && r.payload.deviceId === fixture.r1.getId());
      const posRecovery = fixture.rows.map((r, i) => ({ r, i }))
        .filter(({ r }) => r.topic === 'ipsec.sa.installed' && r.payload.deviceId === fixture.r1.getId())
        .map(({ i }) => i)
        .filter((i) => i > posRupture)[0];

      expect(posEstablish).toBeGreaterThanOrEqual(0);
      expect(posReplay).toBeGreaterThan(posEstablish);
      expect(posRupture).toBeGreaterThan(posReplay);
      expect(posRecovery).toBeGreaterThan(posRupture);
    });
  });

  describe('10.G — Cisco show logging restitutes the operator-visible incident', () => {
    it('show logging on R1 lists both the IKE install and IKE deletion', async () => {
      const log = await fixture.r1.executeCommand('show logging');
      expect(log).toMatch(/IKE SA installed/);
      expect(log).toMatch(/IKE SA deleted/);
    });
  });

  describe('10.H — cross-layer correlation (Cisco IKE-delete ↔ PC ICMP-timeout)', () => {
    it('PC1 host.icmp.echo-timeout during rupture falls in the R1 SA-delete window', () => {
      const timeline = fixture.timeline;
      const pcTimeouts = fixture.rows.filter((r) =>
        r.topic === 'host.icmp.echo-timeout' && r.source === fixture.pc1.getId()
        && r.timestamp >= timeline.phase4 && r.timestamp <= timeline.phase5);
      const ikeDeletes = fixture.rows.filter((r) =>
        r.topic === 'ipsec.ike.sa-deleted' && r.payload.deviceId === fixture.r1.getId()
        && r.timestamp >= timeline.phase4 && r.timestamp <= timeline.phase5);

      expect(ikeDeletes.length).toBeGreaterThan(0);
      expect(pcTimeouts.length).toBeGreaterThan(0);
      for (const to of pcTimeouts) {
        expect(to.timestamp).toBeGreaterThanOrEqual(ikeDeletes[0].timestamp);
      }
    });
  });

  describe('10.I — event stream is filterable per device', () => {
    it('the R1 subset and the R2 subset partition the ipsec.sa.installed events', () => {
      const installs = fixture.rows.filter((r) => r.topic === 'ipsec.sa.installed');
      const onR1 = installs.filter((r) => r.payload.deviceId === fixture.r1.getId());
      const onR2 = installs.filter((r) => r.payload.deviceId === fixture.r2.getId());
      expect(onR1.length + onR2.length).toBe(installs.length);
      expect(onR1.length).toBeGreaterThan(0);
      expect(onR2.length).toBeGreaterThan(0);
    });
  });

  describe('10.J — event stream is filterable per event class', () => {
    it('IKE, IPSEC-SA and anti-replay classes come from disjoint topics', () => {
      const ike = fixture.rows.filter((r) => r.topic.startsWith('ipsec.ike.'));
      const sa = fixture.rows.filter((r) => r.topic === 'ipsec.sa.installed' || r.topic === 'ipsec.sa.deleted');
      const replay = fixture.rows.filter((r) =>
        r.topic === 'log' && (r.payload as { event?: string }).event === 'ipsec:anti-replay');
      expect(ike.length).toBeGreaterThan(0);
      expect(sa.length).toBeGreaterThan(0);
      expect(replay.length).toBeGreaterThan(0);
    });
  });

  describe('10.K — root-cause attribution from the raw log stream', () => {
    it('the IKE-delete event exposes a reason field distinguishing manual/dpd/lifetime/replaced/shutdown', () => {
      const deletes = fixture.rows.filter((r) =>
        r.topic === 'ipsec.ike.sa-deleted' && r.payload.deviceId === fixture.r1.getId());
      expect(deletes.length).toBeGreaterThan(0);
      const reason = deletes[0].payload.reason;
      expect(['manual', 'dpd', 'lifetime', 'replaced', 'shutdown']).toContain(reason);
      expect(reason).toBe('manual');
    });
  });
});
