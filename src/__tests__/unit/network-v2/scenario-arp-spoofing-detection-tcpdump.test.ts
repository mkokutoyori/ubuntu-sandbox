/**
 * Scénario 5 — Détection d'ARP Spoofing avec tcpdump et outils natifs Linux.
 *
 * Le pipeline `awk '{print $NF, $(NF-2)}'` du scénario suppose une ligne ARP
 * se terminant par le MAC (`... is-at <mac>`) ; ce simulateur, comme le vrai
 * tcpdump, ajoute `, length N` après le MAC — les champs réellement utiles
 * sont donc `$(NF-4)` (IP) et `$(NF-2)` (MAC), vérifié empiriquement contre
 * la sortie `-e` réelle de la plateforme. Même remarque pour la section
 * "détournement de trafic" : le préfixe `-e` inclut `ethertype IPv4
 * (0x0800), length N:` avant les adresses IP, donc le MAC destination est
 * en `$4` (avec virgule), pas `$7`.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { Hub } from '@/network/devices/Hub';
import { Cable } from '@/network/hardware/Cable';
import { IPAddress, SubnetMask, MACAddress, resetCounters } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';

const GATEWAY_IP = '192.168.10.1';
const ATTACKER_IP = '192.168.10.10';
const VICTIM_IP = '192.168.10.101';
const OBSERVER_IP = '192.168.10.50';

beforeEach(() => {
  resetCounters();
  MACAddress.resetCounter();
  resetDeviceCounters();
  Logger.reset();
  EquipmentRegistry.resetInstance();
});

interface SpoofLab { gw: LinuxServer; attacker: LinuxPC; victim: LinuxPC; observer: LinuxPC }

function buildSpoofLab(): SpoofLab {
  const hub = new Hub('HUB1', 5, 0, 0);
  const gw = new LinuxServer('linux-server', 'GW', 0, 0);
  const attacker = new LinuxPC('linux-pc', 'ATTACKER', 0, 0);
  const victim = new LinuxPC('linux-pc', 'VICTIM', 0, 0);
  const observer = new LinuxPC('linux-pc', 'OBSERVER', 0, 0);
  new Cable('c1').connect(gw.getPort('eth0')!, hub.getPort('eth0')!);
  new Cable('c2').connect(attacker.getPort('eth0')!, hub.getPort('eth1')!);
  new Cable('c3').connect(victim.getPort('eth0')!, hub.getPort('eth2')!);
  new Cable('c4').connect(observer.getPort('eth0')!, hub.getPort('eth3')!);
  gw.getPort('eth0')!.configureIP(new IPAddress(GATEWAY_IP), new SubnetMask('255.255.255.0'));
  attacker.getPort('eth0')!.configureIP(new IPAddress(ATTACKER_IP), new SubnetMask('255.255.255.0'));
  victim.getPort('eth0')!.configureIP(new IPAddress(VICTIM_IP), new SubnetMask('255.255.255.0'));
  observer.getPort('eth0')!.configureIP(new IPAddress(OBSERVER_IP), new SubnetMask('255.255.255.0'));
  return { gw, attacker, victim, observer };
}

async function captureOn(pc: LinuxPC, cmd: string, stimulus: () => Promise<unknown>): Promise<string> {
  const pending = pc.executeCommand(cmd);
  await new Promise((r) => setTimeout(r, 20));
  await stimulus();
  await new Promise((r) => setTimeout(r, 30));
  return pending;
}

function macOf(host: LinuxServer | LinuxPC): string {
  return host.getPort('eth0')!.getMAC().toString();
}

describe('Scénario 5 — Détection d\'ARP Spoofing', () => {
  it('la commande de capture des réponses ARP réussit sans erreur, avec écriture pcap', async () => {
    const { observer } = buildSpoofLab();
    const out = await observer.executeCommand(`tcpdump -i eth0 -nn -e 'arp[6:2] == 2' -w /tmp/arp-replies.pcap`);
    expect(out).not.toMatch(/tcpdump: error/);
  });

  describe('simulation d\'empoisonnement ARP avec outils natifs', () => {
    it('arping -A émet un vrai Gratuitous ARP REPLY, visible sur le fil', async () => {
      const { attacker, observer } = buildSpoofLab();
      const dump = await captureOn(
        observer, `tcpdump -nn -e 'arp[6:2] == 2'`,
        () => attacker.executeCommand(`arping -A -c 5 -I eth0 ${GATEWAY_IP}`),
      );
      const replyLines = dump.split('\n').filter((l) => l.includes('Reply'));
      expect(replyLines.length).toBe(5);
      for (const line of replyLines) {
        expect(line).toContain(`Reply ${GATEWAY_IP} is-at ${macOf(attacker)}`);
      }
    });

    it('ip neigh replace modifie le cache ARP local et arp -n / ip neigh show le reflètent', async () => {
      const { victim } = buildSpoofLab();
      const spoofedMac = 'aa:bb:cc:dd:ee:ff';
      await victim.executeCommand(`ip neigh replace ${GATEWAY_IP} lladdr ${spoofedMac} dev eth0 nud permanent`);

      const neigh = await victim.executeCommand('ip neigh show dev eth0');
      expect(neigh).toContain(GATEWAY_IP);
      expect(neigh).toContain(spoofedMac);
      expect(neigh).toMatch(/PERMANENT/);

      const arpN = await victim.executeCommand('arp -n');
      const rows = arpN.split('\n').slice(1);
      expect(rows.some((r) => r.includes(GATEWAY_IP) && r.toLowerCase().includes(spoofedMac))).toBe(true);
    });
  });

  describe('détection d\'IPs annoncées avec plusieurs MACs différentes', () => {
    it('le pipeline awk isole sans faux positif l\'IP répondue par deux MACs distincts', async () => {
      const { gw, attacker, victim, observer } = buildSpoofLab();

      const pending = observer.executeCommand(`tcpdump -c 10 -nn -e 'arp[6:2] == 2' -w /tmp/arp-replies.pcap`);
      await new Promise((r) => setTimeout(r, 20));
      // Réponse légitime : le vrai propriétaire de GATEWAY_IP répond à une requête ARP normale.
      await victim.executeCommand(`ping -c 1 ${GATEWAY_IP}`).catch(() => {});
      // Réponse frauduleuse : l'attaquant annonce la même IP en Gratuitous ARP.
      await attacker.executeCommand(`arping -A -c 1 -I eth0 ${GATEWAY_IP}`);
      await new Promise((r) => setTimeout(r, 30));
      await pending;

      const alertReport = await observer.executeCommand(
        `tcpdump -nn -e -r /tmp/arp-replies.pcap | grep 'Reply' | ` +
        `awk '{print $(NF-4), $(NF-2)}' | sort | uniq | ` +
        `awk '{ip[$1]++; mac[$1]=mac[$1]" "$2} END {for (i in ip) if (ip[i]>1) print "ALERTE ARP SPOOFING:", i, "annoncé avec MACs:", mac[i]}'`,
      );

      expect(alertReport).toMatch(/ALERTE ARP SPOOFING: 192\.168\.10\.1\b/);
      expect(alertReport).toContain(macOf(gw));
      expect(alertReport).toContain(macOf(attacker));
    });
  });

  describe('corrélation avec l\'état du cache ARP', () => {
    it('diff des snapshots ip neigh show avant/après expose exactement l\'entrée empoisonnée', async () => {
      const { victim } = buildSpoofLab();
      await victim.executeCommand(`ping -c 1 ${GATEWAY_IP}`).catch(() => {});
      const before = await victim.executeCommand('ip neigh show');
      await victim.executeCommand(`ip neigh replace ${GATEWAY_IP} lladdr aa:bb:cc:dd:ee:ff dev eth0 nud permanent`);
      const after = await victim.executeCommand('ip neigh show');

      expect(before).not.toBe(after);
      expect(before).not.toContain('aa:bb:cc:dd:ee:ff');
      expect(after).toContain('aa:bb:cc:dd:ee:ff');
      expect(after).toContain(GATEWAY_IP);
    });

    it('la cohérence IP/MAC entre deux snapshots arp -n identifie l\'incohérence', async () => {
      const { victim } = buildSpoofLab();
      await victim.executeCommand(`ping -c 1 ${GATEWAY_IP}`).catch(() => {});
      const before = await victim.executeCommand('arp -n');
      await victim.executeCommand(`ip neigh replace ${GATEWAY_IP} lladdr aa:bb:cc:dd:ee:ff dev eth0 nud permanent`);
      const after = await victim.executeCommand('arp -n');

      const combined = [...before.split('\n').slice(1), ...after.split('\n').slice(1)]
        .filter((l) => l.trim().length > 0);
      const report = combined.join('\n');
      const seen: Record<string, string> = {};
      const incoherences: string[] = [];
      for (const line of report.split('\n')) {
        const cols = line.trim().split(/\s+/);
        const ip = cols[0];
        const mac = cols[2];
        if (seen[ip] && seen[ip] !== mac) {
          incoherences.push(`INCOHÉRENCE: ${ip} était ${seen[ip]} maintenant ${mac}`);
        }
        seen[ip] = mac;
      }
      expect(incoherences.length).toBe(1);
      expect(incoherences[0]).toContain(GATEWAY_IP);
    });
  });

  describe('confirmation du détournement de trafic', () => {
    it('la MAC de destination des paquets IP de la victime bascule vers celle de l\'attaquant après empoisonnement', async () => {
      const { gw, attacker, victim, observer } = buildSpoofLab();
      await victim.executeCommand(`ip route add default via ${GATEWAY_IP}`);

      const before = await captureOn(
        observer, `tcpdump -nn -e 'ip and src ${VICTIM_IP}'`,
        () => victim.executeCommand(`ping -c 1 8.8.8.8`).catch(() => {}),
      );
      const beforeDstMac = before.split('\n')
        .find((l) => l.includes('ethertype IPv4'))
        ?.split(/\s+/)[3]?.replace(',', '');
      expect(beforeDstMac).toBe(macOf(gw));

      await victim.executeCommand(`ip neigh replace ${GATEWAY_IP} lladdr ${macOf(attacker)} dev eth0 nud permanent`);

      const after = await captureOn(
        observer, `tcpdump -nn -e 'ip and src ${VICTIM_IP}'`,
        () => victim.executeCommand(`ping -c 1 8.8.8.8`).catch(() => {}),
      );
      const afterDstMac = after.split('\n')
        .find((l) => l.includes('ethertype IPv4'))
        ?.split(/\s+/)[3]?.replace(',', '');
      expect(afterDstMac).toBe(macOf(attacker));
      expect(afterDstMac).not.toBe(beforeDstMac);
    });
  });

  describe('critère de réussite', () => {
    it('détection multi-MAC sans faux positif, diff des caches ARP précis, et redirection de trafic confirmée', async () => {
      const { gw, attacker, victim, observer } = buildSpoofLab();

      const dump = await captureOn(observer, `tcpdump -nn -e 'arp[6:2] == 2' -c 10`, async () => {
        await victim.executeCommand(`ping -c 1 ${GATEWAY_IP}`).catch(() => {});
        await attacker.executeCommand(`arping -A -c 1 -I eth0 ${GATEWAY_IP}`);
      });
      const pairs = dump.split('\n')
        .filter((l) => l.includes('Reply'))
        .map((l) => {
          const cols = l.trim().split(/\s+/);
          return { ip: cols[cols.length - 5], mac: cols[cols.length - 3].replace(',', '') };
        });
      const macsForGateway = new Set(pairs.filter((p) => p.ip === GATEWAY_IP).map((p) => p.mac));
      expect(macsForGateway.size).toBe(2);
      expect(macsForGateway.has(macOf(gw))).toBe(true);
      expect(macsForGateway.has(macOf(attacker))).toBe(true);

      const before = await victim.executeCommand('ip neigh show');
      await victim.executeCommand(`ip neigh replace ${GATEWAY_IP} lladdr ${macOf(attacker)} dev eth0 nud permanent`);
      const after = await victim.executeCommand('ip neigh show');
      expect(after).not.toBe(before);
      expect(after).toContain(macOf(attacker));
    });
  });
});
