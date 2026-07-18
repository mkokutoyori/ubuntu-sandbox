/**
 * Scénario 6 — Détection d'un tunnel DNS par analyse de payload tcpdump et
 * outils shell natifs.
 *
 * `host` n'acceptait pas `-t <type>` malgré sa propre usage string (bug réel,
 * corrigé sur la plateforme). `A?`/`TXT?`/… apparaît comme un token séparé
 * du nom de domaine dans la sortie tcpdump réelle (`A? label.domain (N)`),
 * donc le `grep -oP '\b[...]+\?'` du scénario — qui suppose `label.domain?`
 * collé — ne peut pas extraire le qname : les pipelines ci-dessous ciblent
 * le token qui suit le marqueur de type, vérifié empiriquement contre la
 * sortie réelle de la plateforme.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { IPAddress, SubnetMask, resetCounters } from '@/network/core/types';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { Cable } from '@/network/hardware/Cable';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import type { VirtualFileSystem } from '@/network/devices/linux/VirtualFileSystem';

const NS1_IP = '10.0.1.10';
const PC_IP = '10.0.1.2';
const TUNNEL_DOMAIN = 'c2-server.exemple.com';

function zoneFile(): string {
  return [
    `$ORIGIN ${TUNNEL_DOMAIN}.`,
    '$TTL 3600',
    `@       IN SOA  ns1.${TUNNEL_DOMAIN}. admin.${TUNNEL_DOMAIN}. ( 1 3600 900 604800 300 )`,
    `        IN NS   ns1.${TUNNEL_DOMAIN}.`,
    'ns1     IN A    10.0.1.10',
    'www     IN A    10.0.1.80',
    'info    IN TXT  "official site info"',
    '',
  ].join('\n');
}

function namedConf(): string {
  return [
    'options {',
    '  directory "/var/cache/bind";',
    '  recursion no;',
    '};',
    `zone "${TUNNEL_DOMAIN}" {`,
    '  type primary;',
    `  file "/etc/bind/db.${TUNNEL_DOMAIN}";`,
    '};',
    '',
  ].join('\n');
}

function vfsOf(server: LinuxServer): VirtualFileSystem {
  return (server as unknown as { executor: { vfs: VirtualFileSystem } }).executor.vfs;
}
function writeRoot(server: LinuxServer, path: string, content: string): void {
  vfsOf(server).writeFile(path, content, 0, 0, 0o022);
}

async function buildTunnelLab(): Promise<{ pc: LinuxPC; srv: LinuxServer }> {
  const pc = new LinuxPC('linux-pc', 'PC1');
  const srv = new LinuxServer('linux-server', 'NS1');
  pc.configureInterface('eth0', new IPAddress(PC_IP), new SubnetMask('255.255.255.0'));
  srv.configureInterface('eth0', new IPAddress(NS1_IP), new SubnetMask('255.255.255.0'));
  new Cable('c1').connect(pc.getPort('eth0')!, srv.getPort('eth0')!);
  writeRoot(srv, '/etc/bind/named.conf', namedConf());
  writeRoot(srv, `/etc/bind/db.${TUNNEL_DOMAIN}`, zoneFile());
  await srv.executeCommand('systemctl start named');
  return { pc, srv };
}

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  Logger.clear();
  EquipmentRegistry.resetInstance();
});

function randomLabel(len: number): string {
  const alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let s = '';
  for (let i = 0; i < len; i++) s += alphabet[Math.floor(Math.random() * alphabet.length)];
  return s;
}

const QUERY_LINE = '(A|AAAA|TXT|MX|CNAME)\\? [A-Za-z0-9.-]+ \\(\\d+\\)';

async function captureToFile(pc: LinuxPC, file: string, stimulus: () => Promise<unknown>): Promise<void> {
  const pending = pc.executeCommand(`tcpdump -c 100 -nn -vvv 'port 53' -w ${file}`);
  await new Promise((r) => setTimeout(r, 20));
  await stimulus();
  await new Promise((r) => setTimeout(r, 30));
  await pending;
}

describe('Scénario 6 — Détection d\'un tunnel DNS', () => {
  it('la simulation de sous-domaines longs et la capture simultanée réussissent sans erreur', async () => {
    const { pc } = await buildTunnelLab();
    const pending = pc.executeCommand(`tcpdump -i eth0 -nn -vvv 'port 53' -w /tmp/dns-anomaly.pcap`);
    await new Promise((r) => setTimeout(r, 20));
    await pc.executeCommand(`host ${randomLabel(40)}.${TUNNEL_DOMAIN} ${NS1_IP}`);
    await new Promise((r) => setTimeout(r, 30));
    const out = await pending;
    expect(out).not.toMatch(/tcpdump: error/);
  });

  describe('analyse des longueurs de sous-domaines', () => {
    it('les labels > 30 caractères sont marqués SUSPECT, sans faux positif sur le trafic légitime court', async () => {
      const { pc } = await buildTunnelLab();
      const longLabels = Array.from({ length: 5 }, () => randomLabel(40));

      await captureToFile(pc, '/tmp/dns-anomaly.pcap', async () => {
        for (const label of longLabels) {
          await pc.executeCommand(`host ${label}.${TUNNEL_DOMAIN} ${NS1_IP}`).catch(() => {});
        }
        await pc.executeCommand(`host www.${TUNNEL_DOMAIN} ${NS1_IP}`);
        await pc.executeCommand(`host ns1.${TUNNEL_DOMAIN} ${NS1_IP}`);
      });

      const report = await pc.executeCommand(
        `tcpdump -nn -vvv -r /tmp/dns-anomaly.pcap 'port 53' | ` +
        `grep -oP '${QUERY_LINE}' | awk '{n=split($2, parts, "."); label=parts[1]; len=length(label); ` +
        `if (len > 30) print "SUSPECT (longueur="len"):", $2; else print "NORMAL (longueur="len"):", $2}'`,
      );

      for (const label of longLabels) {
        expect(report).toMatch(new RegExp(`SUSPECT \\(longueur=40\\): ${label}\\.`));
      }
      expect(report).toMatch(/NORMAL \(longueur=3\): www\./);
      expect(report).toMatch(/NORMAL \(longueur=3\): ns1\./);
      const suspectCount = (report.match(/SUSPECT/g) ?? []).length;
      expect(suspectCount).toBe(longLabels.length);
    });
  });

  describe('détection par fréquence de requêtes', () => {
    it('le domaine parent tunnel domine largement le nombre de requêtes', async () => {
      const { pc } = await buildTunnelLab();
      const tunnelLabels = Array.from({ length: 8 }, () => randomLabel(40));

      await captureToFile(pc, '/tmp/dns-anomaly.pcap', async () => {
        for (const label of tunnelLabels) {
          await pc.executeCommand(`host ${label}.${TUNNEL_DOMAIN} ${NS1_IP}`).catch(() => {});
        }
        await pc.executeCommand(`host www.${TUNNEL_DOMAIN} ${NS1_IP}`);
      });

      const report = await pc.executeCommand(
        `tcpdump -nn -vvv -r /tmp/dns-anomaly.pcap 'port 53' | ` +
        `grep -oP '${QUERY_LINE}' | ` +
        `awk '{n=split($2, p, "."); print p[n-2]"."p[n-1]"."p[n]}' | sort | uniq -c | sort -rn | head -1`,
      );

      expect(report).toContain(TUNNEL_DOMAIN);
      expect(report.trim().startsWith(String(tunnelLabels.length + 1))).toBe(true);
    });
  });

  describe('détection par types d\'enregistrements anormaux', () => {
    it('la distribution des types de requêtes expose une proportion anormale de TXT', async () => {
      const { pc } = await buildTunnelLab();

      await captureToFile(pc, '/tmp/dns-anomaly.pcap', async () => {
        // Trafic légitime : quelques requêtes A normales.
        await pc.executeCommand(`host www.${TUNNEL_DOMAIN} ${NS1_IP}`);
        await pc.executeCommand(`host ns1.${TUNNEL_DOMAIN} ${NS1_IP}`);
        // Trafic tunnel : `host` n'interroge qu'en A ; un vrai tunnel type
        // dnscat2 encode dans des requêtes TXT pour une capacité par
        // requête plus grande — simulé ici via `dig ... TXT`.
        for (let i = 0; i < 6; i++) {
          await pc.executeCommand(`dig @${NS1_IP} ${randomLabel(40)}.${TUNNEL_DOMAIN} TXT`).catch(() => {});
        }
      });

      const distribution = await pc.executeCommand(
        `tcpdump -nn -vvv -r /tmp/dns-anomaly.pcap 'port 53' | ` +
        `grep -oP 'A\\?|AAAA\\?|TXT\\?|MX\\?|CNAME\\?' | sort | uniq -c | sort -rn | ` +
        `awk '{total+=$1; types[$2]=$1} END {for (t in types) printf "%s | %d | %.1f%%\\n", t, types[t], types[t]/total*100}'`,
      );

      const txtLine = distribution.split('\n').find((l) => l.startsWith('TXT?'));
      expect(txtLine).toBeDefined();
      const txtPercent = Number(/\|\s*([\d.]+)%/.exec(txtLine!)?.[1]);
      expect(txtPercent).toBeGreaterThan(50);
    });
  });

  describe('critère de réussite', () => {
    it('longueur, fréquence et distribution des types identifient le tunnel sans faux positif', async () => {
      const { pc } = await buildTunnelLab();
      const tunnelLabels = Array.from({ length: 4 }, () => randomLabel(35));

      await captureToFile(pc, '/tmp/dns-anomaly.pcap', async () => {
        await pc.executeCommand(`host www.${TUNNEL_DOMAIN} ${NS1_IP}`);
        for (const label of tunnelLabels) {
          await pc.executeCommand(`dig @${NS1_IP} ${label}.${TUNNEL_DOMAIN} TXT`).catch(() => {});
        }
      });

      const lengthReport = await pc.executeCommand(
        `tcpdump -nn -vvv -r /tmp/dns-anomaly.pcap 'port 53' | ` +
        `grep -oP '${QUERY_LINE}' | awk '{n=split($2, parts, "."); label=parts[1]; len=length(label); ` +
        `if (len > 30) print "SUSPECT (longueur="len"):", $2; else print "NORMAL (longueur="len"):", $2}'`,
      );
      const suspectCount = (lengthReport.match(/SUSPECT/g) ?? []).length;
      expect(suspectCount).toBe(tunnelLabels.length);
      expect(lengthReport).toMatch(/NORMAL \(longueur=3\): www\./);

      const typeReport = await pc.executeCommand(
        `tcpdump -nn -vvv -r /tmp/dns-anomaly.pcap 'port 53' | ` +
        `grep -oP 'A\\?|AAAA\\?|TXT\\?|MX\\?|CNAME\\?' | sort | uniq -c | sort -rn`,
      );
      expect(typeReport).toMatch(new RegExp(`${tunnelLabels.length}\\s+TXT\\?`));
    });
  });
});
