/**
 * Scénario 4 — Détection de scan de ports par analyse des flags TCP avec
 * tcpdump et outils natifs (awk/sort/uniq/grep), sans outil de sécurité
 * dédié.
 *
 * NULL/FIN/XMAS scans exigent des sockets raw (nmap lui-même en a besoin,
 * et un `nc` sans privilège ne peut pas les émettre) : ces segments sont
 * injectés directement sur le fil via `sendFrame`, ce qu'un attaquant réel
 * ferait via une socket raw — pas une simplification du test.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { Hub } from '@/network/devices/Hub';
import { Cable } from '@/network/hardware/Cable';
import {
  IPAddress, SubnetMask, MACAddress, resetCounters,
  ETHERTYPE_IPV4, IP_PROTO_TCP, computeIPv4Checksum,
  type EthernetFrame, type IPv4Packet,
} from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import { noFlags, computeTcpChecksum, type TcpSegment, type TcpFlags } from '@/network/tcp/types';

const ATTACKER_IP = '192.168.10.10';
const TARGET_IP = '192.168.10.102';
const OBSERVER_IP = '192.168.10.50';

beforeEach(() => {
  resetCounters();
  MACAddress.resetCounter();
  resetDeviceCounters();
  Logger.reset();
  EquipmentRegistry.resetInstance();
});

interface ScanLab { attacker: LinuxPC; target: LinuxServer; observer: LinuxPC }

function buildScanLab(): ScanLab {
  const hub = new Hub('HUB1', 4, 0, 0);
  const attacker = new LinuxPC('linux-pc', 'ATTACKER', 0, 0);
  const target = new LinuxServer('linux-server', 'TARGET', 0, 0);
  const observer = new LinuxPC('linux-pc', 'OBSERVER', 0, 0);
  new Cable('c1').connect(attacker.getPort('eth0')!, hub.getPort('eth0')!);
  new Cable('c2').connect(target.getPort('eth0')!, hub.getPort('eth1')!);
  new Cable('c3').connect(observer.getPort('eth0')!, hub.getPort('eth2')!);
  attacker.getPort('eth0')!.configureIP(new IPAddress(ATTACKER_IP), new SubnetMask('255.255.255.0'));
  target.getPort('eth0')!.configureIP(new IPAddress(TARGET_IP), new SubnetMask('255.255.255.0'));
  observer.getPort('eth0')!.configureIP(new IPAddress(OBSERVER_IP), new SubnetMask('255.255.255.0'));
  target.getTcpStack().listen(80, { onAccept: () => {} });
  return { attacker, target, observer };
}

/** Crafts and puts a raw TCP segment with arbitrary flags directly on the wire — what a raw-socket scanner does. */
function sendCraftedSegment(from: LinuxPC, to: LinuxServer, dstPort: number, flags: Partial<TcpFlags>): void {
  const seg: TcpSegment = {
    type: 'tcp', sourcePort: 55555, destinationPort: dstPort,
    sequence: 1000, acknowledgement: 0, dataOffset: 5,
    flags: { ...noFlags(), ...flags },
    window: 1024, checksum: 0, urgentPointer: 0, options: [], payload: undefined,
  };
  const fromIp = from.getPort('eth0')!.getIPAddress()!.toString();
  const toIp = to.getPort('eth0')!.getIPAddress()!.toString();
  seg.checksum = computeTcpChecksum(seg, fromIp, toIp);
  const ip: IPv4Packet = {
    type: 'ipv4', version: 4, ihl: 5, tos: 0, totalLength: 40,
    identification: 1, flags: 0, fragmentOffset: 0, ttl: 64, protocol: IP_PROTO_TCP,
    headerChecksum: 0, sourceIP: new IPAddress(fromIp), destinationIP: new IPAddress(toIp),
    payload: seg,
  };
  ip.headerChecksum = computeIPv4Checksum(ip);
  const frame: EthernetFrame = {
    srcMAC: from.getPort('eth0')!.getMAC(), dstMAC: to.getPort('eth0')!.getMAC(),
    etherType: ETHERTYPE_IPV4, payload: ip,
  };
  from.sendFrame('eth0', frame);
}

async function captureOn(pc: LinuxPC, cmd: string, stimulus: () => Promise<unknown>): Promise<string> {
  const pending = pc.executeCommand(cmd);
  await new Promise((r) => setTimeout(r, 20));
  await stimulus();
  await new Promise((r) => setTimeout(r, 30));
  return pending;
}

describe('Scénario 4 — Détection de scan de ports par analyse des flags TCP', () => {
  it('les commandes de capture SYN et RST réussissent sans erreur, avec écriture pcap', async () => {
    const { observer } = buildScanLab();
    const synOut = await observer.executeCommand(`tcpdump -i eth0 -nn -S 'tcp[tcpflags] == tcp-syn' -w /tmp/syn-capture.pcap`);
    const rstOut = await observer.executeCommand(`tcpdump -i eth0 -nn 'tcp[tcpflags] & tcp-rst != 0' -w /tmp/rst-capture.pcap`);
    expect(synOut).not.toMatch(/tcpdump: error/);
    expect(rstOut).not.toMatch(/tcpdump: error/);
  });

  describe('simulation et détection d\'un scan de ports natif (nc -z)', () => {
    it('identifie la source du scan par comptage de SYN via awk/sort/uniq', async () => {
      const { attacker, observer } = buildScanLab();
      const ports = [21, 22, 23, 25, 80, 443, 3306];

      const pending = observer.executeCommand(`tcpdump -c 50 -nn 'tcp[tcpflags] == tcp-syn' -w /tmp/syn-capture.pcap`);
      await new Promise((r) => setTimeout(r, 20));
      await Promise.all(ports.map((p) => attacker.executeCommand(`nc -z -w 1 ${TARGET_IP} ${p}`).catch(() => {})));
      await new Promise((r) => setTimeout(r, 30));
      await pending;

      const report = await observer.executeCommand(
        `tcpdump -nn -r /tmp/syn-capture.pcap | awk '{print $3}' | cut -d. -f1-4 | sort | uniq -c | sort -rn`,
      );

      expect(report).toMatch(new RegExp(`${ports.length}\\s+${ATTACKER_IP.replace(/\./g, '\\.')}`));
    });

    it('reconstitue la séquence de ports ciblés depuis la capture', async () => {
      const { attacker, observer } = buildScanLab();
      const ports = [21, 22, 23, 25, 80, 443, 3306];

      const pending = observer.executeCommand(`tcpdump -c 50 -nn 'tcp[tcpflags] == tcp-syn' -w /tmp/syn-capture.pcap`);
      await new Promise((r) => setTimeout(r, 20));
      await Promise.all(ports.map((p) => attacker.executeCommand(`nc -z -w 1 ${TARGET_IP} ${p}`).catch(() => {})));
      await new Promise((r) => setTimeout(r, 30));
      await pending;

      const portList = await observer.executeCommand(
        `tcpdump -nn -r /tmp/syn-capture.pcap | grep -oP '\\.\\d+:' | tr -d '.:' | sort -n | uniq`,
      );
      const seen = portList.split('\n').map(Number).filter((n) => !Number.isNaN(n));
      for (const p of ports) expect(seen).toContain(p);
    });

    it('les ports fermés génèrent un RST réel distinguable des ports ouverts', async () => {
      const { attacker, observer } = buildScanLab();
      // 22 (sshd) is open by default on any LinuxServer, like a real box —
      // only 21/23/25 have no service modeled and are genuinely closed.
      const closedPorts = [21, 23, 25];

      const pending = observer.executeCommand(`tcpdump -c 50 -nn 'tcp[tcpflags] & tcp-rst != 0' -w /tmp/rst-capture.pcap`);
      await new Promise((r) => setTimeout(r, 20));
      await Promise.all([...closedPorts, 80].map((p) => attacker.executeCommand(`nc -z -w 1 ${TARGET_IP} ${p}`).catch(() => {})));
      await new Promise((r) => setTimeout(r, 30));
      await pending;

      const rstCount = await observer.executeCommand(
        `tcpdump -nn -r /tmp/rst-capture.pcap | awk '{print $3}' | grep -oP '\\.\\d+$' | tr -d '.' | sort -n | uniq -c`,
      );
      for (const p of closedPorts) expect(rstCount).toMatch(new RegExp(`1 ${p}\\b`));
      expect(rstCount).not.toMatch(/\b80\b/);
    });
  });

  describe('détection de flags TCP anormaux', () => {
    it('NULL scan : tcp[tcpflags] == 0 capture le segment sans aucun flag, sans faux positif sur le trafic légitime', async () => {
      const { attacker, target, observer } = buildScanLab();
      const dump = await captureOn(observer, `tcpdump -nn 'tcp[tcpflags] == 0'`, async () => {
        sendCraftedSegment(attacker, target, 9999, {});
        await attacker.executeCommand(`nc -z -w 1 ${TARGET_IP} 80`).catch(() => {});
      });

      expect(dump).toMatch(/Flags \[\.\]|length 0/);
      expect(dump).not.toMatch(/Flags \[S\]/);
    });

    it('XMAS scan : tcp[tcpflags] == (tcp-fin|tcp-push|tcp-urg) isole exactement FIN+PSH+URG', async () => {
      const { attacker, target, observer } = buildScanLab();
      const dump = await captureOn(observer, `tcpdump -nn -c 5 'tcp[tcpflags] == (tcp-fin|tcp-push|tcp-urg)'`, async () => {
        sendCraftedSegment(attacker, target, 9999, { fin: true, psh: true, urg: true });
        sendCraftedSegment(attacker, target, 9998, { fin: true });
        await attacker.executeCommand(`nc -z -w 1 ${TARGET_IP} 80`).catch(() => {});
      });

      expect(dump).toMatch(/Flags \[FPU\]/);
      expect(dump).not.toMatch(/Flags \[S\]/);
      const flaggedLines = dump.split('\n').filter((l) => l.includes('Flags ['));
      expect(flaggedLines.length).toBe(1);
    });

    it('FIN scan : tcp[tcpflags] == tcp-fin isole exactement FIN seul, sans PSH ni URG', async () => {
      const { attacker, target, observer } = buildScanLab();
      const dump = await captureOn(observer, `tcpdump -nn -c 5 'tcp[tcpflags] == tcp-fin'`, async () => {
        sendCraftedSegment(attacker, target, 9998, { fin: true });
        sendCraftedSegment(attacker, target, 9999, { fin: true, psh: true, urg: true });
        await attacker.executeCommand(`nc -z -w 1 ${TARGET_IP} 80`).catch(() => {});
      });

      const flaggedLines = dump.split('\n').filter((l) => l.includes('Flags ['));
      expect(flaggedLines.length).toBe(1);
      expect(flaggedLines[0]).toMatch(/Flags \[F\]/);
    });
  });

  describe('critère de réussite', () => {
    it('le pipeline awk/sort/uniq identifie la source anormale sans outil tiers, et les filtres BPF ne produisent aucun faux positif sur du trafic légitime', async () => {
      const { attacker, target, observer } = buildScanLab();
      const ports = [21, 22, 23, 25, 80];

      const pending = observer.executeCommand(`tcpdump -c 50 -nn 'tcp[tcpflags] == tcp-syn' -w /tmp/syn-capture.pcap`);
      await new Promise((r) => setTimeout(r, 20));
      await Promise.all(ports.map((p) => attacker.executeCommand(`nc -z -w 1 ${TARGET_IP} ${p}`).catch(() => {})));
      await new Promise((r) => setTimeout(r, 30));
      await pending;

      const topTalkers = await observer.executeCommand(
        `tcpdump -nn -r /tmp/syn-capture.pcap | awk '{print $3}' | cut -d. -f1-4 | sort | uniq -c | sort -rn | head -1`,
      );
      expect(topTalkers).toContain(ATTACKER_IP);
      expect(topTalkers.trim().startsWith(String(ports.length))).toBe(true);

      const nullDump = await captureOn(observer, `tcpdump -nn 'tcp[tcpflags] == 0'`, async () => {
        await attacker.executeCommand(`nc -z -w 1 ${TARGET_IP} 80`).catch(() => {});
      });
      expect(nullDump.split('\n').some((l) => l.includes('Flags ['))).toBe(false);
      void target;
    });
  });
});
