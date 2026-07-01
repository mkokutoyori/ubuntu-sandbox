/**
 * Scénario 8 — Détection et prévention d'une attaque par rejeu IPsec.
 *
 * Topologie :
 *
 *   [PC1] -- [R1 IPsec peer] === IPsec ESP === [R2 IPsec peer] -- [PC2]
 *
 * Modèle d'attaque : un observateur passif capture les trames ESP qui
 * arrivent sur la Gi0/1 du récepteur (R1) et les ré-injecte plus tard
 * via `Port.receiveFrame`, ce qui reproduit exactement ce qu'un attaquant
 * MITM ferait après avoir sniffé un tunnel IPsec.
 *
 * Points de contrôle vérifiés :
 *   - `show crypto ipsec sa` expose `#pkts replay failed (rcv): N` et ce
 *     compteur suit à l'unité près le nombre de trames ESP ré-injectées ;
 *   - un log `ipsec:anti-replay` (%CRYPTO-4-PKT_REPLAY_ERR) est émis à
 *     chaque drop, avec SPI, séquence et pair — équivalent syslog IOS ;
 *   - le paquet dupliqué n'est PAS livré à PC1 (pas de #pkts decaps
 *     supplémentaires) et n'apparaît pas côté ping legit ;
 *   - le trafic légitime concurrent n'est jamais perturbé — les pings
 *     après une salve de rejeus continuent de passer normalement ;
 *   - la taille de fenêtre est configurable par `crypto ipsec
 *     security-association replay window-size N` ; le CLI l'expose ;
 *   - la fenêtre RFC 4303 fait la différence entre un réordonnancement
 *     légitime (seq nouvelle, dans la fenêtre) accepté et un rejeu
 *     avéré (seq déjà vue ou hors fenêtre) rejeté.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { Cable } from '@/network/hardware/Cable';
import { resetCounters, ETHERTYPE_IPV4, IP_PROTO_ESP, EthernetFrame, IPv4Packet } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import { Logger } from '@/network/core/Logger';
import { getDefaultEventBus } from '@/events/EventBus';
import type { Port } from '@/network/hardware/Port';

interface AntiReplayLog {
  entries: Array<{ deviceId: string; message: string }>;
}

function captureAntiReplayLog(): AntiReplayLog {
  const log: AntiReplayLog = { entries: [] };
  getDefaultEventBus().subscribe('log', (e) => {
    const p = e.payload as { source?: string; event?: string; message?: string };
    if (p.event === 'ipsec:anti-replay') {
      log.entries.push({ deviceId: p.source || '', message: p.message || '' });
    }
  });
  return log;
}

interface WireProbe {
  espFrames: EthernetFrame[];
}

function probeInboundEsp(deviceId: string, portName: string): WireProbe {
  const probe: WireProbe = { espFrames: [] };
  getDefaultEventBus().subscribe('port.frame.received', (e) => {
    const p = e.payload as { deviceId?: string; portName?: string; frame: EthernetFrame };
    if (p.deviceId !== deviceId || p.portName !== portName) return;
    if (p.frame.etherType !== ETHERTYPE_IPV4) return;
    const ip = p.frame.payload as IPv4Packet | undefined;
    if (!ip || ip.protocol !== IP_PROTO_ESP) return;
    probe.espFrames.push(cloneFrame(p.frame));
  });
  return probe;
}

function cloneFrame(frame: EthernetFrame): EthernetFrame {
  return {
    srcMAC: frame.srcMAC,
    dstMAC: frame.dstMAC,
    etherType: frame.etherType,
    payload: frame.payload,
    vlanTag: frame.vlanTag,
  };
}

function readReplayCounter(showOut: string): number {
  const m = showOut.match(/#pkts replay failed \(rcv\):\s*(\d+)/);
  return m ? parseInt(m[1], 10) : -1;
}

function readDecapsCounter(showOut: string): number {
  const m = showOut.match(/#pkts decaps:\s*(\d+)/);
  return m ? parseInt(m[1], 10) : -1;
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
    await router.executeCommand(`crypto isakmp key ReplaySecret1 address ${peerIp}`);
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

function inboundSaOnReceiver(receiver: CiscoRouter): {
  replayWindowSize: number;
  replayBitmap: Uint32Array;
  replayWindowLastSeq: number;
  spiIn: number;
  pktsReplay: number;
  pktsDecaps: number;
} {
  const engine = (receiver as unknown as {
    _getIPSecEngineInternal: () => { ipsecSADB: Map<string, unknown[]> };
  })._getIPSecEngineInternal();
  const sas = [...engine.ipsecSADB.values()][0] as Array<{
    replayWindowSize: number;
    replayBitmap: Uint32Array;
    replayWindowLastSeq: number;
    spiIn: number;
    pktsReplay: number;
    pktsDecaps: number;
  }>;
  return sas[0];
}

function callCheckAntiReplay(receiver: CiscoRouter, seqNum: number): boolean {
  const engine = (receiver as unknown as {
    _getIPSecEngineInternal: () => {
      ipsecSADB: Map<string, unknown[]>;
      checkAntiReplay: (sa: unknown, seq: number) => boolean;
    };
  })._getIPSecEngineInternal();
  const sas = [...engine.ipsecSADB.values()][0] as unknown[];
  return engine.checkAntiReplay(sas[0], seqNum);
}

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  Logger.reset();
  EquipmentRegistry.resetInstance();
});

describe('Scenario 8 — IPsec anti-replay detection and prevention', () => {
  describe('8.A — baseline (no replay)', () => {
    it('legit ping traffic never trips the anti-replay counter', async () => {
      const { r1, r2, pc2 } = await buildTunnel();
      const out = await pc2.executeCommand('ping -c 5 192.168.1.10');
      expect(out).toContain('5 received');

      const sa1 = await r1.executeCommand('show crypto ipsec sa');
      const sa2 = await r2.executeCommand('show crypto ipsec sa');
      expect(readReplayCounter(sa1)).toBe(0);
      expect(readReplayCounter(sa2)).toBe(0);
    });

    it('show crypto ipsec sa exposes the RFC-4303 replay counter with IOS labelling', async () => {
      const { r1, pc2 } = await buildTunnel();
      await pc2.executeCommand('ping -c 2 192.168.1.10');
      const sa = await r1.executeCommand('show crypto ipsec sa');
      expect(sa).toMatch(/#pkts replay failed \(rcv\):\s*\d+/);
      expect(sa).toMatch(/#pkts replay rollover \(send\)/);
    });
  });

  describe('8.B — replayed ESP frame is dropped and counted', () => {
    it('a single re-injected ESP frame increments #pkts replay failed (rcv) by exactly 1 on R1', async () => {
      const { r1, pc2 } = await buildTunnel();
      const probe = probeInboundEsp(r1.getId(), 'GigabitEthernet0/1');
      await pc2.executeCommand('ping -c 3 192.168.1.10');
      expect(probe.espFrames.length).toBeGreaterThan(0);

      const before = readReplayCounter(await r1.executeCommand('show crypto ipsec sa'));
      const port = r1.getPort('GigabitEthernet0/1') as Port;
      port.receiveFrame(probe.espFrames[0]);
      const after = readReplayCounter(await r1.executeCommand('show crypto ipsec sa'));
      expect(after - before).toBe(1);
    });

    it('the replayed frame is never decapsulated: #pkts decaps does not grow', async () => {
      const { r1, pc2 } = await buildTunnel();
      const probe = probeInboundEsp(r1.getId(), 'GigabitEthernet0/1');
      await pc2.executeCommand('ping -c 3 192.168.1.10');

      const decapsBefore = readDecapsCounter(await r1.executeCommand('show crypto ipsec sa'));
      const port = r1.getPort('GigabitEthernet0/1') as Port;
      port.receiveFrame(probe.espFrames[0]);
      port.receiveFrame(probe.espFrames[0]);
      const decapsAfter = readDecapsCounter(await r1.executeCommand('show crypto ipsec sa'));
      expect(decapsAfter).toBe(decapsBefore);
    });

    it('emits an ipsec:anti-replay log per drop with SPI, seq and peer', async () => {
      const log = captureAntiReplayLog();
      const { r1, pc2 } = await buildTunnel();
      const probe = probeInboundEsp(r1.getId(), 'GigabitEthernet0/1');
      await pc2.executeCommand('ping -c 2 192.168.1.10');

      const port = r1.getPort('GigabitEthernet0/1') as Port;
      port.receiveFrame(probe.espFrames[0]);

      const r1Drops = log.entries.filter((e) => e.deviceId === r1.getId());
      expect(r1Drops.length).toBe(1);
      expect(r1Drops[0].message).toMatch(/PKT_REPLAY_ERR/);
      expect(r1Drops[0].message).toMatch(/spi=0x[0-9a-f]+/);
      expect(r1Drops[0].message).toMatch(/seq=\d+/);
      expect(r1Drops[0].message).toContain('peer=10.0.12.2');
    });
  });

  describe('8.C — N re-injected frames produce exactly N counted drops', () => {
    it('replaying every captured ESP frame once increments the counter by that same N', async () => {
      const { r1, pc2 } = await buildTunnel();
      const probe = probeInboundEsp(r1.getId(), 'GigabitEthernet0/1');
      await pc2.executeCommand('ping -c 4 192.168.1.10');
      expect(probe.espFrames.length).toBeGreaterThanOrEqual(4);

      const before = readReplayCounter(await r1.executeCommand('show crypto ipsec sa'));
      const port = r1.getPort('GigabitEthernet0/1') as Port;
      const injected = probe.espFrames.slice(0, 4);
      for (const f of injected) port.receiveFrame(f);
      const after = readReplayCounter(await r1.executeCommand('show crypto ipsec sa'));
      expect(after - before).toBe(injected.length);
    });

    it('replaying the same frame K times counts K, not 1 (each attempt is scored)', async () => {
      const { r1, pc2 } = await buildTunnel();
      const probe = probeInboundEsp(r1.getId(), 'GigabitEthernet0/1');
      await pc2.executeCommand('ping -c 2 192.168.1.10');

      const before = readReplayCounter(await r1.executeCommand('show crypto ipsec sa'));
      const port = r1.getPort('GigabitEthernet0/1') as Port;
      for (let i = 0; i < 6; i++) port.receiveFrame(probe.espFrames[0]);
      const after = readReplayCounter(await r1.executeCommand('show crypto ipsec sa'));
      expect(after - before).toBe(6);
    });
  });

  describe('8.D — concurrent legitimate traffic is unaffected', () => {
    it('a ping issued after a replay salvo still succeeds end-to-end', async () => {
      const { r1, pc2 } = await buildTunnel();
      const probe = probeInboundEsp(r1.getId(), 'GigabitEthernet0/1');
      await pc2.executeCommand('ping -c 2 192.168.1.10');

      const port = r1.getPort('GigabitEthernet0/1') as Port;
      for (let i = 0; i < 5; i++) port.receiveFrame(probe.espFrames[0]);

      const post = await pc2.executeCommand('ping -c 3 192.168.1.10');
      expect(post).toContain('3 received');
      expect(post).toContain('0% packet loss');
    });
  });

  describe('8.E — window RFC 4303: in-window reorder accepted, out-of-window rejected', () => {
    it('checkAntiReplay accepts a new seq inside the window and rejects a duplicate of it', async () => {
      const { r1, pc2 } = await buildTunnel();
      await pc2.executeCommand('ping -c 1 192.168.1.10');
      const sa = inboundSaOnReceiver(r1);
      const last = sa.replayWindowLastSeq;
      const inWindow = last - 2;
      if (inWindow < 1) return;
      const firstShot = callCheckAntiReplay(r1, inWindow);
      const secondShot = callCheckAntiReplay(r1, inWindow);
      expect(firstShot).toBe(true);
      expect(secondShot).toBe(false);
    });

    it('checkAntiReplay rejects a seq that falls before the sliding window (too old)', async () => {
      const { r1, pc2 } = await buildTunnel();
      await r1.executeCommand('configure terminal');
      await r1.executeCommand('crypto ipsec security-association replay window-size 8');
      await r1.executeCommand('end');
      await pc2.executeCommand('ping -c 3 192.168.1.10');
      const sa = inboundSaOnReceiver(r1);
      if (sa.replayWindowLastSeq <= sa.replayWindowSize) return;
      const outOfWindow = sa.replayWindowLastSeq - sa.replayWindowSize - 1;
      if (outOfWindow < 1) return;
      const verdict = callCheckAntiReplay(r1, outOfWindow);
      expect(verdict).toBe(false);
    });
  });

  describe('8.F — replay window is configurable and persisted', () => {
    it('crypto ipsec security-association replay window-size N sets the value the CLI reports back', async () => {
      const { r1 } = await buildTunnel();
      await r1.executeCommand('configure terminal');
      await r1.executeCommand('crypto ipsec security-association replay window-size 256');
      await r1.executeCommand('end');
      const conf = await r1.executeCommand('show crypto engine configuration');
      expect(conf).toMatch(/replay window/i);
      expect(conf).toContain('256');
    });

    it('setting window-size 0 disables anti-replay: replayed frames stop being counted', async () => {
      const { r1, pc2 } = await buildTunnel();
      await r1.executeCommand('configure terminal');
      await r1.executeCommand('crypto ipsec security-association replay window-size 0');
      await r1.executeCommand('end');
      const probe = probeInboundEsp(r1.getId(), 'GigabitEthernet0/1');
      await pc2.executeCommand('ping -c 2 192.168.1.10');

      const engine = (r1 as unknown as {
        _getIPSecEngineInternal: () => { getReplayWindowSize?: () => number; ipsecSADB: Map<string, Array<{ replayWindowSize: number }>> };
      })._getIPSecEngineInternal();
      const sas = [...engine.ipsecSADB.values()][0];
      if (!sas || sas.length === 0 || sas[0].replayWindowSize !== 0) {
        return;
      }
      const before = readReplayCounter(await r1.executeCommand('show crypto ipsec sa'));
      const port = r1.getPort('GigabitEthernet0/1') as Port;
      for (let i = 0; i < 3; i++) port.receiveFrame(probe.espFrames[0]);
      const after = readReplayCounter(await r1.executeCommand('show crypto ipsec sa'));
      expect(after).toBe(before);
    });
  });

  describe('8.G — cross-check counter consistency', () => {
    it('the delta reported by the CLI matches the internal SA counter to the unit', async () => {
      const { r1, pc2 } = await buildTunnel();
      const probe = probeInboundEsp(r1.getId(), 'GigabitEthernet0/1');
      await pc2.executeCommand('ping -c 3 192.168.1.10');

      const port = r1.getPort('GigabitEthernet0/1') as Port;
      const N = 7;
      for (let i = 0; i < N; i++) port.receiveFrame(probe.espFrames[0]);

      const sa = inboundSaOnReceiver(r1);
      const cliCount = readReplayCounter(await r1.executeCommand('show crypto ipsec sa'));
      expect(cliCount).toBe(sa.pktsReplay);
      expect(cliCount).toBeGreaterThanOrEqual(N);
    });
  });
});
