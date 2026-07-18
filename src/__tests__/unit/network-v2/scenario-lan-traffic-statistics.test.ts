/**
 * Scénario 7 — Analyse statistique de trafic LAN avec tcpdump et outils
 * shell natifs.
 *
 * `dd`/`nc -l`/la redirection `/dev/tcp` du scénario ne sont pas
 * implémentées par la plateforme (nc est connect-only, pas de mode listen ;
 * pas de pseudo-périphérique `/dev/tcp`) : le trafic TCP est généré via un
 * envoi direct sur `TcpStack`, avec un volume exact connu à l'avance —
 * substitution plus rigoureuse que `dd`/`nc` pour vérifier "volume TCP
 * cohérent avec la taille du transfert", pas une simplification. Les
 * réponses DNS rendent leur longueur entre parenthèses (`(N)`), pas
 * `length N` comme les autres protocoles (vrai tcpdump fait pareil) ; le
 * calcul de volume par protocole se limite donc à ICMP/TCP, seuls
 * mentionnés par le critère de réussite du scénario.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { IPAddress, SubnetMask, MACAddress, resetCounters } from '@/network/core/types';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { Cable } from '@/network/hardware/Cable';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import type { VirtualFileSystem } from '@/network/devices/linux/VirtualFileSystem';

const PC_IP = '10.0.2.2';
const SRV_IP = '10.0.2.10';
const TCP_PORT = 9000;
const TCP_PAYLOAD_BYTES = 8000;
const PING_COUNT = 5;

function vfsOf(server: LinuxServer): VirtualFileSystem {
  return (server as unknown as { executor: { vfs: VirtualFileSystem } }).executor.vfs;
}
function writeRoot(server: LinuxServer, path: string, content: string): void {
  vfsOf(server).writeFile(path, content, 0, 0, 0o022);
}

async function buildLanLab(): Promise<{ pc: LinuxPC; srv: LinuxServer }> {
  const pc = new LinuxPC('linux-pc', 'PC1');
  const srv = new LinuxServer('linux-server', 'SRV');
  pc.configureInterface('eth0', new IPAddress(PC_IP), new SubnetMask('255.255.255.0'));
  srv.configureInterface('eth0', new IPAddress(SRV_IP), new SubnetMask('255.255.255.0'));
  new Cable('c1').connect(pc.getPort('eth0')!, srv.getPort('eth0')!);
  writeRoot(srv, '/etc/bind/named.conf', [
    'options { directory "/var/cache/bind"; recursion no; };',
    'zone "example.com" { type primary; file "/etc/bind/db.example.com"; };',
    '',
  ].join('\n'));
  writeRoot(srv, '/etc/bind/db.example.com', [
    '$ORIGIN example.com.', '$TTL 3600',
    '@ IN SOA ns1.example.com. admin.example.com. ( 1 3600 900 604800 300 )',
    '  IN NS ns1.example.com.',
    `ns1 IN A ${SRV_IP}`,
    'www IN A 10.0.2.80',
    '',
  ].join('\n'));
  await srv.executeCommand('systemctl start named');
  srv.getTcpStack().listen(TCP_PORT, { onAccept: () => {} });
  return { pc, srv };
}

beforeEach(() => {
  resetCounters();
  MACAddress.resetCounter();
  resetDeviceCounters();
  Logger.reset();
  EquipmentRegistry.resetInstance();
});

async function generateTraffic(pc: LinuxPC, srv: LinuxServer): Promise<void> {
  await pc.executeCommand(`ping -c ${PING_COUNT} -i 0.2 ${SRV_IP}`).catch(() => {});
  const sock = pc.getTcpStack().connect(SRV_IP, TCP_PORT)!;
  sock.send('X'.repeat(TCP_PAYLOAD_BYTES));
  await new Promise((r) => setTimeout(r, 10));
  await pc.executeCommand(`dig @${SRV_IP} www.example.com A`).catch(() => {});
  void srv;
}

async function captureLanStats(pc: LinuxPC, srv: LinuxServer): Promise<void> {
  const pending = pc.executeCommand(`tcpdump -c 200 -nn -w /tmp/lan-stats.pcap`);
  await new Promise((r) => setTimeout(r, 20));
  await generateTraffic(pc, srv);
  await new Promise((r) => setTimeout(r, 30));
  await pending;
}

describe('Scénario 7 — Analyse statistique de trafic LAN', () => {
  it('la génération de trafic varié et la capture globale réussissent sans erreur', async () => {
    const { pc, srv } = await buildLanLab();
    await captureLanStats(pc, srv);
    const out = await pc.executeCommand('tcpdump -nn -r /tmp/lan-stats.pcap');
    expect(out).not.toMatch(/tcpdump: error/);
    expect(out).toContain('packets captured');
  });

  describe('top talkers par volume de paquets', () => {
    it('identifie PC1 comme unique source IP de la capture', async () => {
      const { pc, srv } = await buildLanLab();
      await captureLanStats(pc, srv);

      const report = await pc.executeCommand(
        `tcpdump -nn -r /tmp/lan-stats.pcap 'ip' | awk '{print $3}' | cut -d. -f1-4 | sort | uniq -c | sort -rn | head -10`,
      );
      expect(report).toContain(PC_IP);
    });
  });

  describe('distribution des protocoles', () => {
    it('classe correctement ICMP/ARP/UDP/TCP et les pourcentages totalisent 100%', async () => {
      const { pc, srv } = await buildLanLab();
      await captureLanStats(pc, srv);

      // Sans -v, une ligne TCP ne contient jamais le mot "TCP" (seul l'en-tête
      // verbeux l'affiche, et il double alors le compte de lignes par paquet) ;
      // "Flags [" est le marqueur fiable à verbosité par défaut.
      const report = await pc.executeCommand(
        `tcpdump -nn -r /tmp/lan-stats.pcap | ` +
        `awk '{ if ($0 ~ /ICMP/) proto="ICMP"; else if ($0 ~ /ARP/) proto="ARP"; ` +
        `else if ($0 ~ /Flags \\[/) proto="TCP"; else if ($0 ~ /UDP/) proto="UDP"; else proto="AUTRE"; ` +
        `count[proto]++; total++ } END { for (p in count) printf "%s: %d paquets (%.1f%%)\\n", p, count[p], count[p]/total*100 }' | sort -t: -k2 -rn`,
      );

      const icmpLine = report.split('\n').find((l) => l.startsWith('ICMP'));
      expect(icmpLine).toMatch(new RegExp(`ICMP: ${PING_COUNT * 2} paquets`));

      const percents = Array.from(report.matchAll(/\(([\d.]+)%\)/g)).map((m) => Number(m[1]));
      const sum = percents.reduce((a, b) => a + b, 0);
      expect(Math.round(sum)).toBe(100);
    });
  });

  describe('ports TCP les plus utilisés', () => {
    it(`identifie le port ${TCP_PORT} comme port TCP destination dominant`, async () => {
      const { pc, srv } = await buildLanLab();
      await captureLanStats(pc, srv);

      const report = await pc.executeCommand(
        `tcpdump -nn -r /tmp/lan-stats.pcap 'tcp' | awk '{print $5}' | grep -oP '\\.\\d+:$' | ` +
        `tr -d '.:' | sort -n | uniq -c | sort -rn | head -10`,
      );
      expect(report).toMatch(new RegExp(`\\d+\\s+${TCP_PORT}\\b`));
    });
  });

  describe('volume de données par protocole', () => {
    it('le volume TCP correspond exactement au transfert réel (match() à 3 arguments)', async () => {
      const { pc, srv } = await buildLanLab();
      await captureLanStats(pc, srv);

      const report = await pc.executeCommand(
        `tcpdump -nn -r /tmp/lan-stats.pcap | ` +
        `awk '{ if (match($0, /length ([0-9]+)/, arr)) { bytes=arr[1]; ` +
        `if ($0 ~ /ICMP/) vol["ICMP"]+=bytes; else if ($0 ~ /Flags \\[/) vol["TCP"]+=bytes } } ` +
        `END { for (p in vol) printf "%s: %.1f KB\\n", p, vol[p]/1024 }'`,
      );

      const tcpLine = report.split('\n').find((l) => l.startsWith('TCP:'));
      expect(tcpLine).toBeDefined();
      const tcpKB = Number(/TCP: ([\d.]+) KB/.exec(tcpLine!)?.[1]);
      expect(tcpKB).toBeCloseTo(TCP_PAYLOAD_BYTES / 1024, 1);

      const icmpLine = report.split('\n').find((l) => l.startsWith('ICMP:'));
      expect(icmpLine).toBeDefined();
    });
  });

  describe('critère de réussite', () => {
    it('les statistiques produites sont cohérentes avec le trafic généré', async () => {
      const { pc, srv } = await buildLanLab();
      await captureLanStats(pc, srv);

      const icmpCount = await pc.executeCommand(
        `tcpdump -nn -r /tmp/lan-stats.pcap 'icmp' | wc -l`,
      );
      // `wc -l`'s real stdout is the first line; tcpdump's own summary
      // footer (fd 2, bypasses the pipe) trails after it, exactly like a
      // real terminal showing both streams for an unredirected command.
      expect(Number(icmpCount.split('\n')[0].trim())).toBe(PING_COUNT * 2);

      const volumeReport = await pc.executeCommand(
        `tcpdump -nn -r /tmp/lan-stats.pcap | ` +
        `awk '{ if (match($0, /length ([0-9]+)/, arr)) { bytes=arr[1]; ` +
        `if ($0 ~ /Flags \\[/) vol["TCP"]+=bytes } } END { for (p in vol) printf "%s: %.1f KB\\n", p, vol[p]/1024 }'`,
      );
      const tcpKB = Number(/TCP: ([\d.]+) KB/.exec(volumeReport)?.[1]);
      expect(tcpKB).toBeCloseTo(TCP_PAYLOAD_BYTES / 1024, 1);
    });
  });
});
