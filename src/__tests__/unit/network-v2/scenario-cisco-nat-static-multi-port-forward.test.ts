/**
 * Scénario 11 (Cisco) — NAT statique avec port forwarding vers plusieurs
 * serveurs sur la même IP publique.
 *
 * Transcription littérale et fidèle : 8 redirections de port statiques
 * (`ip nat inside source static tcp|udp ...`) sur l'unique IP publique
 * 203.0.113.1 vers 5 serveurs internes distincts (DC01 : SSH+DNS,
 * SRV-WEB : HTTP+HTTPS, SRV-ORACLE : 1521, SRV-MAIL : SMTP+IMAP,
 * SRV-SUPERVISION : SNMP), distinguées uniquement par le port de
 * destination, y compris HTTP et HTTPS coexistant sur le même hôte et
 * la même IP publique.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { GenericSwitch } from '@/network/devices/GenericSwitch';
import { Cable } from '@/network/hardware/Cable';
import { IPAddress, SubnetMask, MACAddress, resetCounters } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';

const DC01_IP = '192.168.10.10';
const SRV_WEB_IP = '192.168.10.50';
const SRV_ORACLE_IP = '192.168.10.20';
const SRV_MAIL_IP = '192.168.10.30';
const SRV_SUPERVISION_IP = '192.168.99.10';
const GW_INSIDE = '192.168.10.254';
const GW_OUTSIDE = '203.0.113.1';
const OUTSIDE_IP = '203.0.113.2';

interface Lab {
  dc01: LinuxServer;
  srvWeb: LinuxServer;
  outside: LinuxServer;
  router: CiscoRouter;
}

async function buildLab(): Promise<Lab> {
  const lanSw = new GenericSwitch('switch-generic', 'lan-sw', 8, 0, 0);
  const wanSw = new GenericSwitch('switch-generic', 'wan-sw', 8, 0, 0);
  const router = new CiscoRouter('router', 0, 0);
  const dc01 = new LinuxServer('linux-server', 'dc01', 0, 0);
  const srvWeb = new LinuxServer('linux-server', 'srv-web', 0, 0);
  const srvOracle = new LinuxServer('linux-server', 'srv-oracle', 0, 0);
  const srvMail = new LinuxServer('linux-server', 'srv-mail', 0, 0);
  const srvSupervision = new LinuxServer('linux-server', 'srv-supervision', 0, 0);
  const outside = new LinuxServer('linux-server', 'outside', 0, 0);

  new Cable('a').connect(dc01.getPort('eth0')!, lanSw.getPorts()[0]);
  new Cable('b').connect(srvWeb.getPort('eth0')!, lanSw.getPorts()[1]);
  new Cable('c').connect(srvOracle.getPort('eth0')!, lanSw.getPorts()[2]);
  new Cable('g').connect(srvMail.getPort('eth0')!, lanSw.getPorts()[3]);
  new Cable('h').connect(srvSupervision.getPort('eth0')!, lanSw.getPorts()[4]);
  new Cable('d').connect(lanSw.getPorts()[7], router.getPort('GigabitEthernet0/0')!);
  new Cable('e').connect(router.getPort('GigabitEthernet0/1')!, wanSw.getPorts()[0]);
  new Cable('f').connect(wanSw.getPorts()[1], outside.getPort('eth0')!);

  const m = new SubnetMask('255.255.255.0');
  dc01.getPorts()[0].configureIP(new IPAddress(DC01_IP), m);
  srvWeb.getPorts()[0].configureIP(new IPAddress(SRV_WEB_IP), m);
  srvOracle.getPorts()[0].configureIP(new IPAddress(SRV_ORACLE_IP), m);
  srvMail.getPorts()[0].configureIP(new IPAddress(SRV_MAIL_IP), m);
  srvSupervision.getPorts()[0].configureIP(new IPAddress(SRV_SUPERVISION_IP), new SubnetMask('255.255.255.0'));
  for (const h of [dc01, srvWeb, srvOracle, srvMail]) h.setDefaultGateway(new IPAddress(GW_INSIDE));

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
    `ip nat inside source static tcp ${DC01_IP} 22 ${GW_OUTSIDE} 22`,
    `ip nat inside source static tcp ${SRV_WEB_IP} 443 ${GW_OUTSIDE} 443`,
    `ip nat inside source static tcp ${SRV_WEB_IP} 80 ${GW_OUTSIDE} 80`,
    `ip nat inside source static tcp ${SRV_ORACLE_IP} 1521 ${GW_OUTSIDE} 1521`,
    `ip nat inside source static udp ${DC01_IP} 53 ${GW_OUTSIDE} 53`,
    `ip nat inside source static tcp ${SRV_MAIL_IP} 25 ${GW_OUTSIDE} 25`,
    `ip nat inside source static tcp ${SRV_MAIL_IP} 993 ${GW_OUTSIDE} 993`,
    `ip nat inside source static udp ${SRV_SUPERVISION_IP} 161 ${GW_OUTSIDE} 161`,
    `ip route 0.0.0.0 0.0.0.0 GigabitEthernet0/1`,
    'end',
  ]) await router.executeCommand(cmd);

  return { dc01, srvWeb, outside, router };
}

describe('Scénario 11 (Cisco) — NAT statique multi-port-forwarding sur une IP publique unique', () => {
  beforeEach(() => {
    resetCounters();
    MACAddress.resetCounter();
    resetDeviceCounters();
    Logger.reset();
    EquipmentRegistry.resetInstance();
  });

  describe('configuration complète des 8 redirections', () => {
    it('getStaticEntries expose les 8 entrées avec leur protocole/port exacts', async () => {
      const { router } = await buildLab();
      const entries = router._getNATEngine().getStaticEntries();
      expect(entries).toHaveLength(8);

      const ssh = entries.find(e => e.localIP === DC01_IP && e.localPort === 22);
      expect(ssh?.globalPort).toBe(22);
      const https = entries.find(e => e.localIP === SRV_WEB_IP && e.localPort === 443);
      expect(https?.globalPort).toBe(443);
      const http = entries.find(e => e.localIP === SRV_WEB_IP && e.localPort === 80);
      expect(http?.globalPort).toBe(80);
      const oracle = entries.find(e => e.localIP === SRV_ORACLE_IP && e.localPort === 1521);
      expect(oracle?.globalPort).toBe(1521);
      const dns = entries.find(e => e.localIP === DC01_IP && e.localPort === 53 && e.protocol === 'udp');
      expect(dns?.globalPort).toBe(53);
      const smtp = entries.find(e => e.localIP === SRV_MAIL_IP && e.localPort === 25);
      expect(smtp?.globalPort).toBe(25);
      const imap = entries.find(e => e.localIP === SRV_MAIL_IP && e.localPort === 993);
      expect(imap?.globalPort).toBe(993);
      const snmp = entries.find(e => e.localIP === SRV_SUPERVISION_IP && e.localPort === 161 && e.protocol === 'udp');
      expect(snmp?.globalPort).toBe(161);
    });

    it('show running-config liste les 8 redirections configurées', async () => {
      const { router } = await buildLab();
      const out = await router.executeCommand('show running-config | include ip nat inside source static');
      expect(out).toContain(`ip nat inside source static tcp ${DC01_IP} 22 ${GW_OUTSIDE} 22`);
      expect(out).toContain(`ip nat inside source static tcp ${SRV_WEB_IP} 443 ${GW_OUTSIDE} 443`);
      expect(out).toContain(`ip nat inside source static tcp ${SRV_WEB_IP} 80 ${GW_OUTSIDE} 80`);
      expect(out).toContain(`ip nat inside source static tcp ${SRV_ORACLE_IP} 1521 ${GW_OUTSIDE} 1521`);
      expect(out).toContain(`ip nat inside source static udp ${DC01_IP} 53 ${GW_OUTSIDE} 53`);
      expect(out).toContain(`ip nat inside source static tcp ${SRV_MAIL_IP} 25 ${GW_OUTSIDE} 25`);
      expect(out).toContain(`ip nat inside source static tcp ${SRV_MAIL_IP} 993 ${GW_OUTSIDE} 993`);
      expect(out).toContain(`ip nat inside source static udp ${SRV_SUPERVISION_IP} 161 ${GW_OUTSIDE} 161`);
    });
  });

  describe('vérification de la table de traduction complète', () => {
    it('show ip nat translations montre les 8 entrées avec les ports exacts, sans aucun trafic préalable', async () => {
      const { router } = await buildLab();
      const out = await router.executeCommand('show ip nat translations');
      const g = GW_OUTSIDE.replace(/\./g, '\\.');
      expect(out).toMatch(new RegExp(`tcp\\s+${g}:22\\s+${DC01_IP.replace(/\./g, '\\.')}:22`));
      expect(out).toMatch(new RegExp(`tcp\\s+${g}:443\\s+${SRV_WEB_IP.replace(/\./g, '\\.')}:443`));
      expect(out).toMatch(new RegExp(`tcp\\s+${g}:80\\s+${SRV_WEB_IP.replace(/\./g, '\\.')}:80`));
      expect(out).toMatch(new RegExp(`tcp\\s+${g}:1521\\s+${SRV_ORACLE_IP.replace(/\./g, '\\.')}:1521`));
      expect(out).toMatch(new RegExp(`udp\\s+${g}:53\\s+${DC01_IP.replace(/\./g, '\\.')}:53`));
      expect(out).toMatch(new RegExp(`tcp\\s+${g}:25\\s+${SRV_MAIL_IP.replace(/\./g, '\\.')}:25`));
      expect(out).toMatch(new RegExp(`tcp\\s+${g}:993\\s+${SRV_MAIL_IP.replace(/\./g, '\\.')}:993`));
      expect(out).toMatch(new RegExp(`udp\\s+${g}:161\\s+${SRV_SUPERVISION_IP.replace(/\./g, '\\.')}:161`));
    });

    it('show ip nat statistics rapporte 8 traductions statiques', async () => {
      const { router } = await buildLab();
      const out = await router.executeCommand('show ip nat statistics | include Static');
      expect(out).toMatch(/Static translations:\s*8/);
    });

    it('deux services différents (HTTP et HTTPS) coexistent sur la même IP publique en étant distingués uniquement par leur port', async () => {
      const { router } = await buildLab();
      const entries = router._getNATEngine().getStaticEntries();
      const http = entries.find(e => e.localPort === 80);
      const https = entries.find(e => e.localPort === 443);
      expect(http?.localIP).toBe(SRV_WEB_IP);
      expect(https?.localIP).toBe(SRV_WEB_IP);
      expect(http?.globalIP).toBe(GW_OUTSIDE);
      expect(https?.globalIP).toBe(GW_OUTSIDE);
      expect(http?.globalPort).not.toBe(https?.globalPort);
    });
  });

  describe('test indépendant de chaque redirection depuis une machine externe', () => {
    it('une connexion vers 203.0.113.1:22 (SSH → DC01) ne rencontre pas d\'erreur de routage', async () => {
      const { outside } = await buildLab();
      const out = await outside.executeCommand(`nc -zv ${GW_OUTSIDE} 22`);
      expect(out).not.toMatch(/network is unreachable|no route to host/i);
    });

    it('une connexion vers 203.0.113.1:1521 (Oracle → SRV-ORACLE) ne rencontre pas d\'erreur de routage', async () => {
      const { outside } = await buildLab();
      const out = await outside.executeCommand(`nc -zv ${GW_OUTSIDE} 1521`);
      expect(out).not.toMatch(/network is unreachable|no route to host/i);
    });

    it('une connexion vers 203.0.113.1:25 (SMTP → SRV-MAIL) ne rencontre pas d\'erreur de routage', async () => {
      const { outside } = await buildLab();
      const out = await outside.executeCommand(`nc -zv ${GW_OUTSIDE} 25`);
      expect(out).not.toMatch(/network is unreachable|no route to host/i);
    });
  });

  describe('résolution des conflits de ports', () => {
    it('une 9e redirection réutilisant le port public 22 (déjà mappé vers DC01) vers un autre hôte est rejetée', async () => {
      const { router } = await buildLab();
      await router.executeCommand('configure terminal');
      const out = await router.executeCommand(
        `ip nat inside source static tcp ${SRV_WEB_IP} 2222 ${GW_OUTSIDE} 22`);
      await router.executeCommand('end');

      expect(out).toMatch(/global IP:port already mapped to another inside target/i);
      const entries = router._getNATEngine().getStaticEntries();
      expect(entries).toHaveLength(8);
    });
  });
});
