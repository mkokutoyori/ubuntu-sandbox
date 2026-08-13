/**
 * Scénario 2 (Cisco) — NAT statique : exposition d'un serveur interne
 * avec IP publique fixe.
 *
 * Transcription littérale et fidèle : `ip nat inside source static
 * 192.168.10.20 203.0.113.10` (serveur Oracle) et `... 192.168.10.10
 * 203.0.113.11` (DC01), présence immédiate dans `show ip nat
 * translations` sans trafic préalable (placeholders "---"),
 * bidirectionnalité (le NAT statique a priorité sur le PAT pour le
 * trafic sortant, et le trafic entrant vers l'IP publique dédiée est
 * redirigé vers le serveur interne — RFC 5382 « DNAT »), persistance
 * des entrées statiques après `clear ip nat translation *` (qui
 * n'efface que les sessions dynamiques), et comparaison NAT
 * statique/PAT via `show ip nat statistics`.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { GenericSwitch } from '@/network/devices/GenericSwitch';
import { Cable } from '@/network/hardware/Cable';
import { IPAddress, SubnetMask, MACAddress, resetCounters, createIPv4Packet, IP_PROTO_ICMP } from '@/network/core/types';
import type { ICMPPacket } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import { pingOnSimulatedClock } from '../../support/fastPing';

interface Lab {
  srvOracle: LinuxServer;
  dc01: LinuxServer;
  pcUser: LinuxPC;
  outside: LinuxServer;
  router: CiscoRouter;
}

const SRV_ORACLE_IP = '192.168.10.20';
const DC01_IP = '192.168.10.10';
const PC_USER_IP = '192.168.10.50'; // aucune entrée statique — sort uniquement via PAT
const GW_INSIDE = '192.168.10.254';
const GW_OUTSIDE = '203.0.113.1';
const OUTSIDE_IP = '203.0.113.2';
const ORACLE_PUBLIC_IP = '203.0.113.10';
const DC01_PUBLIC_IP = '203.0.113.11';

async function buildLab(): Promise<Lab> {
  const lanSw = new GenericSwitch('switch-generic', 'lan-sw', 8, 0, 0);
  const wanSw = new GenericSwitch('switch-generic', 'wan-sw', 8, 0, 0);
  const router = new CiscoRouter('router', 0, 0);
  const srvOracle = new LinuxServer('linux-server', 'srv-oracle', 0, 0);
  const dc01 = new LinuxServer('linux-server', 'dc01', 0, 0);
  const pcUser = new LinuxPC('linux-pc', 'pc-user', 0, 0);
  const outside = new LinuxServer('linux-server', 'outside', 0, 0);

  new Cable('a').connect(srvOracle.getPort('eth0')!, lanSw.getPorts()[0]);
  new Cable('b').connect(dc01.getPort('eth0')!, lanSw.getPorts()[1]);
  new Cable('c').connect(pcUser.getPort('eth0')!, lanSw.getPorts()[2]);
  new Cable('d').connect(lanSw.getPorts()[7], router.getPort('GigabitEthernet0/0')!);
  new Cable('e').connect(router.getPort('GigabitEthernet0/1')!, wanSw.getPorts()[0]);
  new Cable('f').connect(wanSw.getPorts()[1], outside.getPort('eth0')!);

  const m = new SubnetMask('255.255.255.0');
  srvOracle.getPorts()[0].configureIP(new IPAddress(SRV_ORACLE_IP), m);
  dc01.getPorts()[0].configureIP(new IPAddress(DC01_IP), m);
  pcUser.getPorts()[0].configureIP(new IPAddress(PC_USER_IP), m);
  srvOracle.setDefaultGateway(new IPAddress(GW_INSIDE));
  dc01.setDefaultGateway(new IPAddress(GW_INSIDE));
  pcUser.setDefaultGateway(new IPAddress(GW_INSIDE));

  const wanMask = new SubnetMask('255.255.255.252');
  outside.getPorts()[0].configureIP(new IPAddress(OUTSIDE_IP), wanMask);
  outside.setDefaultGateway(new IPAddress(GW_OUTSIDE));

  for (const cmd of [
    'enable',
    'configure terminal',
    'interface GigabitEthernet0/0',
    `ip address ${GW_INSIDE} 255.255.255.0`,
    'ip nat inside',
    'no shutdown',
    'exit',
    'interface GigabitEthernet0/1',
    `ip address ${GW_OUTSIDE} 255.255.255.252`,
    'ip nat outside',
    'no shutdown',
    'exit',
    'access-list 1 permit 192.168.10.0 0.0.0.255',
    'ip nat inside source list 1 interface GigabitEthernet0/1 overload',
    `ip nat inside source static ${SRV_ORACLE_IP} ${ORACLE_PUBLIC_IP}`,
    `ip nat inside source static ${DC01_IP} ${DC01_PUBLIC_IP}`,
    `ip route 0.0.0.0 0.0.0.0 GigabitEthernet0/1`,
    'end',
  ]) await router.executeCommand(cmd);

  return { srvOracle, dc01, pcUser, outside, router };
}

describe('Scénario 2 (Cisco) — NAT statique : serveur Oracle exposé avec IP publique fixe', () => {
  beforeEach(() => {
    resetCounters();
    MACAddress.resetCounter();
    resetDeviceCounters();
    Logger.reset();
    EquipmentRegistry.resetInstance();
  });

  describe('configuration NAT statique', () => {
    it('ip nat inside source static crée les deux entrées (Oracle et DC01)', async () => {
      const { router } = await buildLab();
      const entries = router._getNATEngine().getStaticEntries();
      expect(entries).toHaveLength(2);
      expect(entries.find(e => e.localIP === SRV_ORACLE_IP)?.globalIP).toBe(ORACLE_PUBLIC_IP);
      expect(entries.find(e => e.localIP === DC01_IP)?.globalIP).toBe(DC01_PUBLIC_IP);
    });

    it('show ip nat translations montre les deux entrées statiques immédiatement, sans aucun trafic préalable', async () => {
      const { router } = await buildLab();
      const out = await router.executeCommand('show ip nat translations');
      expect(out).toContain(SRV_ORACLE_IP);
      expect(out).toContain(ORACLE_PUBLIC_IP);
      expect(out).toContain(DC01_IP);
      expect(out).toContain(DC01_PUBLIC_IP);
      expect(out).toContain('---');
    });

    it('show running-config | include ip nat inside source static liste les deux commandes', async () => {
      const { router } = await buildLab();
      const out = await router.executeCommand('show running-config | include ip nat inside source static');
      expect(out).toContain(`ip nat inside source static ${SRV_ORACLE_IP} ${ORACLE_PUBLIC_IP}`);
      expect(out).toContain(`ip nat inside source static ${DC01_IP} ${DC01_PUBLIC_IP}`);
    });
  });

  describe('test de la bidirectionnalité', () => {
    it('le trafic sortant du serveur Oracle est traduit vers 203.0.113.10 et non 203.0.113.1 (priorité du NAT statique sur le PAT)', async () => {
      const { router } = await buildLab();
      const engine = router._getNATEngine();
      const icmp: ICMPPacket = { type: 'icmp', icmpType: 8, code: 0, identifier: 1, sequence: 1 };
      const pkt = createIPv4Packet(new IPAddress(SRV_ORACLE_IP), new IPAddress(OUTSIDE_IP), IP_PROTO_ICMP, 64, icmp, 28);
      const translated = engine.translateOutbound(pkt, 'GigabitEthernet0/1', 'GigabitEthernet0/0');
      expect(translated).not.toBeNull();
      expect(translated!.sourceIP.toString()).toBe(ORACLE_PUBLIC_IP);
      expect(translated!.sourceIP.toString()).not.toBe(GW_OUTSIDE);
    });

    it('un ping du serveur Oracle vers l\'extérieur aboutit (round-trip complet à travers le NAT statique)', async () => {
      const { srvOracle } = await buildLab();
      const out = await pingOnSimulatedClock(srvOracle, `ping -c 3 ${OUTSIDE_IP}`);
      expect(out).toMatch(/0% packet loss|3 (packets )?received/i);
    });

    it('le trafic entrant vers 203.0.113.10 (n\'importe quel port) est redirigé vers 192.168.10.20 (DNAT plein cône)', async () => {
      const { router } = await buildLab();
      const engine = router._getNATEngine();
      const icmp: ICMPPacket = { type: 'icmp', icmpType: 8, code: 0, identifier: 1, sequence: 1 };
      const pkt = createIPv4Packet(new IPAddress(OUTSIDE_IP), new IPAddress(ORACLE_PUBLIC_IP), IP_PROTO_ICMP, 64, icmp, 28);
      const translated = engine.translateInbound(pkt, 'GigabitEthernet0/1');
      expect(translated).not.toBeNull();
      expect(translated!.destinationIP.toString()).toBe(SRV_ORACLE_IP);
    });

    it('une connexion depuis l\'extérieur vers 203.0.113.10 (port Oracle 1521) aboutit au serveur Oracle interne', async () => {
      const { outside } = await buildLab();
      const out = await outside.executeCommand(`nc -zv ${ORACLE_PUBLIC_IP} 1521`);
      expect(out).not.toMatch(/network is unreachable|no route to host/i);
    });

    it('clear ip nat translation * efface les sessions PAT dynamiques mais préserve les entrées statiques', async () => {
      const { pcUser, router } = await buildLab();
      // Génère une session PAT dynamique depuis un hôte non statiquement mappé
      // (dc01/srv-oracle sortiraient via leur propre entrée statique, pas le PAT).
      await pcUser.executeCommand(`nc -zv ${OUTSIDE_IP} 80`);

      await router.executeCommand('clear ip nat translation *');

      const out = await router.executeCommand('show ip nat translations');
      expect(out).toContain(SRV_ORACLE_IP);
      expect(out).toContain(ORACLE_PUBLIC_IP);
      expect(out).toContain(DC01_IP);
      expect(out).toContain(DC01_PUBLIC_IP);
    });
  });

  describe('comparaison NAT statique vs PAT', () => {
    it('show ip nat statistics affiche 2 traductions statiques et 0 dynamique en l\'absence de trafic PAT', async () => {
      const { router } = await buildLab();
      const out = await router.executeCommand('show ip nat statistics');
      expect(out).toMatch(/Static translations:\s*2/);
      expect(out).toMatch(/Dynamic translations:\s*0/);
      expect(out).toMatch(/Total active translations:\s*2\s*\(2 static, 0 dynamic/);
    });

    it('une fois du trafic PAT généré par un tiers hôte, Static translations reste à 2 et Dynamic translations augmente', async () => {
      const { pcUser, router } = await buildLab();
      await pcUser.executeCommand(`nc -zv ${OUTSIDE_IP} 80`);

      const out = await router.executeCommand('show ip nat statistics');
      expect(out).toMatch(/Static translations:\s*2/);
      const dynMatch = /Dynamic translations:\s*(\d+)/.exec(out);
      expect(dynMatch).not.toBeNull();
      expect(Number(dynMatch![1])).toBeGreaterThan(0);
    });
  });
});
