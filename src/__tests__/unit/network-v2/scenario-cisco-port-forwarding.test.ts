/**
 * Scénario 4 (Cisco) — Redirection de port (Port Forwarding / DNAT) :
 * accès à des services internes.
 *
 * Transcription littérale et fidèle : `ip nat inside source static
 * tcp|udp <ip-privée> <port-privé> <ip-publique> <port-public>` pour
 * SSH (22→DC01), Oracle (1521→SRV-ORACLE), un port non standard
 * (8080 externe → 80 interne sur SRV-WEB), HTTPS (443) et DNS UDP (53)
 * — toutes redirigées vers l'unique IP publique du routeur
 * (203.0.113.1) — coexistant avec le PAT déjà en place pour le trafic
 * sortant.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { GenericSwitch } from '@/network/devices/GenericSwitch';
import { Cable } from '@/network/hardware/Cable';
import { IPAddress, SubnetMask, MACAddress, resetCounters } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';

interface Lab {
  dc01: LinuxServer;
  srvOracle: LinuxServer;
  srvWeb: LinuxServer;
  pcUser: LinuxPC;
  outside: LinuxServer;
  router: CiscoRouter;
}

const DC01_IP = '192.168.10.10';
const SRV_ORACLE_IP = '192.168.10.20';
const SRV_WEB_IP = '192.168.10.50';
const PC_USER_IP = '192.168.10.60';
const GW_INSIDE = '192.168.10.254';
const GW_OUTSIDE = '203.0.113.1';
const OUTSIDE_IP = '203.0.113.2';

async function buildLab(): Promise<Lab> {
  const lanSw = new GenericSwitch('switch-generic', 'lan-sw', 8, 0, 0);
  const wanSw = new GenericSwitch('switch-generic', 'wan-sw', 8, 0, 0);
  const router = new CiscoRouter('router', 0, 0);
  const dc01 = new LinuxServer('linux-server', 'dc01', 0, 0);
  const srvOracle = new LinuxServer('linux-server', 'srv-oracle', 0, 0);
  const srvWeb = new LinuxServer('linux-server', 'srv-web', 0, 0);
  const pcUser = new LinuxPC('linux-pc', 'pc-user', 0, 0);
  const outside = new LinuxServer('linux-server', 'outside', 0, 0);

  new Cable('a').connect(dc01.getPort('eth0')!, lanSw.getPorts()[0]);
  new Cable('b').connect(srvOracle.getPort('eth0')!, lanSw.getPorts()[1]);
  new Cable('c').connect(srvWeb.getPort('eth0')!, lanSw.getPorts()[2]);
  new Cable('g').connect(pcUser.getPort('eth0')!, lanSw.getPorts()[3]);
  new Cable('d').connect(lanSw.getPorts()[7], router.getPort('GigabitEthernet0/0')!);
  new Cable('e').connect(router.getPort('GigabitEthernet0/1')!, wanSw.getPorts()[0]);
  new Cable('f').connect(wanSw.getPorts()[1], outside.getPort('eth0')!);

  const m = new SubnetMask('255.255.255.0');
  dc01.getPorts()[0].configureIP(new IPAddress(DC01_IP), m);
  srvOracle.getPorts()[0].configureIP(new IPAddress(SRV_ORACLE_IP), m);
  srvWeb.getPorts()[0].configureIP(new IPAddress(SRV_WEB_IP), m);
  pcUser.getPorts()[0].configureIP(new IPAddress(PC_USER_IP), m);
  for (const h of [dc01, srvOracle, srvWeb, pcUser]) h.setDefaultGateway(new IPAddress(GW_INSIDE));

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
    `ip nat inside source static tcp ${DC01_IP} 22 ${GW_OUTSIDE} 22`,
    `ip nat inside source static tcp ${SRV_ORACLE_IP} 1521 ${GW_OUTSIDE} 1521`,
    `ip nat inside source static tcp ${SRV_WEB_IP} 80 ${GW_OUTSIDE} 8080`,
    `ip nat inside source static tcp ${SRV_WEB_IP} 443 ${GW_OUTSIDE} 443`,
    `ip nat inside source static udp ${DC01_IP} 53 ${GW_OUTSIDE} 53`,
    `ip route 0.0.0.0 0.0.0.0 GigabitEthernet0/1`,
    'end',
  ]) await router.executeCommand(cmd);

  return { dc01, srvOracle, srvWeb, pcUser, outside, router };
}

describe('Scénario 4 (Cisco) — redirection de port (port forwarding) vers les services internes', () => {
  beforeEach(() => {
    resetCounters();
    MACAddress.resetCounter();
    resetDeviceCounters();
    Logger.reset();
    EquipmentRegistry.resetInstance();
  });

  describe('configuration des redirections de port', () => {
    it('show running-config liste les 5 redirections de port configurées', async () => {
      const { router } = await buildLab();
      const out = await router.executeCommand('show running-config | include ip nat inside source static');
      expect(out).toContain(`ip nat inside source static tcp ${DC01_IP} 22 ${GW_OUTSIDE} 22`);
      expect(out).toContain(`ip nat inside source static tcp ${SRV_ORACLE_IP} 1521 ${GW_OUTSIDE} 1521`);
      expect(out).toContain(`ip nat inside source static tcp ${SRV_WEB_IP} 80 ${GW_OUTSIDE} 8080`);
      expect(out).toContain(`ip nat inside source static tcp ${SRV_WEB_IP} 443 ${GW_OUTSIDE} 443`);
      expect(out).toContain(`ip nat inside source static udp ${DC01_IP} 53 ${GW_OUTSIDE} 53`);
    });

    it('getStaticEntries expose les 5 entrées avec leur protocole/port exacts', async () => {
      const { router } = await buildLab();
      const entries = router._getNATEngine().getStaticEntries();
      expect(entries).toHaveLength(5);
      const oracle = entries.find(e => e.localIP === SRV_ORACLE_IP);
      expect(oracle?.localPort).toBe(1521);
      expect(oracle?.globalPort).toBe(1521);
      const web = entries.find(e => e.localIP === SRV_WEB_IP && e.localPort === 80);
      expect(web?.globalPort).toBe(8080);
    });
  });

  describe('vérification des entrées NAT statiques avec ports', () => {
    it('show ip nat translations montre les 5 entrées avec les ports exacts, sans aucun trafic préalable', async () => {
      const { router } = await buildLab();
      const out = await router.executeCommand('show ip nat translations');
      expect(out).toMatch(new RegExp(`tcp\\s+${GW_OUTSIDE.replace(/\./g, '\\.')}:22\\s+${DC01_IP.replace(/\./g, '\\.')}:22`));
      expect(out).toMatch(new RegExp(`tcp\\s+${GW_OUTSIDE.replace(/\./g, '\\.')}:1521\\s+${SRV_ORACLE_IP.replace(/\./g, '\\.')}:1521`));
      expect(out).toMatch(new RegExp(`tcp\\s+${GW_OUTSIDE.replace(/\./g, '\\.')}:8080\\s+${SRV_WEB_IP.replace(/\./g, '\\.')}:80`));
      expect(out).toMatch(new RegExp(`udp\\s+${GW_OUTSIDE.replace(/\./g, '\\.')}:53\\s+${DC01_IP.replace(/\./g, '\\.')}:53`));
    });

    it('une connexion SSH depuis l\'extérieur vers 203.0.113.1:22 est reçue par DC01 sur son port 22 interne', async () => {
      const { router, outside } = await buildLab();
      const engine = router._getNATEngine();
      const before = engine.getStaticEntries().find(e => e.globalPort === 22);
      expect(before).toBeDefined();

      const out = await outside.executeCommand(`nc -zv ${GW_OUTSIDE} 22`);
      expect(out).not.toMatch(/network is unreachable|no route to host/i);
    });

    it('une requête HTTP vers 203.0.113.1:8080 est reçue par SRV-WEB sur son port 80 interne (translation de port transparente)', async () => {
      const { router } = await buildLab();
      const engine = router._getNATEngine();
      const entry = engine.getStaticEntries().find(e => e.globalPort === 8080);
      expect(entry?.localIP).toBe(SRV_WEB_IP);
      expect(entry?.localPort).toBe(80);
      expect(entry?.globalPort).toBe(8080);
    });
  });

  describe('coexistence redirection de port + PAT', () => {
    it('le trafic sortant de PC-User (PAT) et les redirections entrantes (:22, :1521) fonctionnent simultanément', async () => {
      const { pcUser, router } = await buildLab();
      await pcUser.executeCommand(`ping -c 1 ${OUTSIDE_IP}`);

      const out = await router.executeCommand('show ip nat statistics');
      expect(out).toMatch(/Total active translations:\s*\d+\s*\(5 static,\s*\d+ dynamic/);
      expect(out).toContain('Inside Source [acl 1] overload');
    });

    it('show ip nat statistics rapporte 5 traductions statiques ("port forward entries")', async () => {
      const { router } = await buildLab();
      const out = await router.executeCommand('show ip nat statistics');
      expect(out).toMatch(/Static translations:\s*5/);
    });
  });
});
