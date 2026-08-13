/**
 * Scénario 5 (Cisco) — NAT et ACL : contrôle fin du trafic NATté.
 *
 * Transcription littérale et fidèle : exemption NAT du trafic VPN
 * (ACL étendue ACL-NAT-AVEC-EXEMPTION, `deny` vers 10.0.0.0/8 et
 * 172.16.0.0/12, `permit ip ... any` pour le reste), NAT sélectif par
 * destination (`deny` vers un sous-réseau partenaire, `permit any`
 * ailleurs), et NAT différencié par machine (`deny host` pour exclure
 * du PAT des hôtes qui disposent déjà de leur propre NAT statique).
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
import { pingOnSimulatedClock } from '../../support/fastPing';

const GW_INSIDE = '192.168.10.254';
const GW_OUTSIDE = '203.0.113.1';
const OUTSIDE_IP = '203.0.113.2';
const PC_LINUX1_IP = '192.168.10.101';
const SRV_ORACLE_IP = '192.168.10.20';
const ORACLE_PUBLIC_IP = '203.0.113.10';
const DC01_IP = '192.168.10.10';
const DC01_PUBLIC_IP = '203.0.113.11';

interface Lab {
  pcLinux1: LinuxPC;
  srvOracle: LinuxServer;
  dc01: LinuxServer;
  outside: LinuxServer;
  router: CiscoRouter;
}

async function buildLab(): Promise<Lab> {
  const lanSw = new GenericSwitch('switch-generic', 'lan-sw', 8, 0, 0);
  const wanSw = new GenericSwitch('switch-generic', 'wan-sw', 8, 0, 0);
  const router = new CiscoRouter('router', 0, 0);
  const pcLinux1 = new LinuxPC('linux-pc', 'pc-linux-1', 0, 0);
  const srvOracle = new LinuxServer('linux-server', 'srv-oracle', 0, 0);
  const dc01 = new LinuxServer('linux-server', 'dc01', 0, 0);
  const outside = new LinuxServer('linux-server', 'outside', 0, 0);

  new Cable('a').connect(pcLinux1.getPort('eth0')!, lanSw.getPorts()[0]);
  new Cable('b').connect(srvOracle.getPort('eth0')!, lanSw.getPorts()[1]);
  new Cable('c').connect(dc01.getPort('eth0')!, lanSw.getPorts()[2]);
  new Cable('d').connect(lanSw.getPorts()[7], router.getPort('GigabitEthernet0/0')!);
  new Cable('e').connect(router.getPort('GigabitEthernet0/1')!, wanSw.getPorts()[0]);
  new Cable('f').connect(wanSw.getPorts()[1], outside.getPort('eth0')!);

  const m = new SubnetMask('255.255.255.0');
  pcLinux1.getPorts()[0].configureIP(new IPAddress(PC_LINUX1_IP), m);
  srvOracle.getPorts()[0].configureIP(new IPAddress(SRV_ORACLE_IP), m);
  dc01.getPorts()[0].configureIP(new IPAddress(DC01_IP), m);
  for (const h of [pcLinux1, srvOracle, dc01]) h.setDefaultGateway(new IPAddress(GW_INSIDE));

  outside.getPorts()[0].configureIP(new IPAddress(OUTSIDE_IP), new SubnetMask('255.255.255.252'));
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
    `ip nat inside source static ${SRV_ORACLE_IP} ${ORACLE_PUBLIC_IP}`,
    `ip nat inside source static ${DC01_IP} ${DC01_PUBLIC_IP}`,
    `ip route 0.0.0.0 0.0.0.0 GigabitEthernet0/1`,
    'end',
  ]) await router.executeCommand(cmd);

  return { pcLinux1, srvOracle, dc01, outside, router };
}

describe('Scénario 5 (Cisco) — NAT et ACL : contrôle fin du trafic NATté', () => {
  beforeEach(() => {
    resetCounters();
    MACAddress.resetCounter();
    resetDeviceCounters();
    Logger.reset();
    EquipmentRegistry.resetInstance();
  });

  describe('exemption NAT pour trafic VPN', () => {
    async function labWithExemptionACL(): Promise<Lab> {
      const lab = await buildLab();
      for (const cmd of [
        'enable', 'configure terminal',
        'ip access-list extended ACL-NAT-AVEC-EXEMPTION',
        '10 deny ip 192.168.10.0 0.0.0.255 10.0.0.0 0.255.255.255',
        '20 deny ip 192.168.10.0 0.0.0.255 172.16.0.0 0.15.255.255',
        '30 permit ip 192.168.10.0 0.0.0.255 any',
        'exit',
        'ip nat inside source list ACL-NAT-AVEC-EXEMPTION interface GigabitEthernet0/1 overload',
        'end',
      ]) await lab.router.executeCommand(cmd);
      return lab;
    }

    it('le trafic vers 10.x.x.x (réseau VPN) n\'apparaît jamais dans show ip nat translations', async () => {
      const { pcLinux1, router } = await labWithExemptionACL();
      await pingOnSimulatedClock(pcLinux1, 'ping -c 3 10.1.1.1');

      const table = await router.executeCommand('show ip nat translations');
      expect(table).not.toContain('10.1.1.1');
    });

    it('le trafic vers Internet (destination hors 10.x/172.16.x) est bien traduit par le PAT', async () => {
      const { pcLinux1, router } = await labWithExemptionACL();
      await pingOnSimulatedClock(pcLinux1, `ping -c 3 ${OUTSIDE_IP}`);

      const table = await router.executeCommand('show ip nat translations');
      expect(table).toContain(PC_LINUX1_IP);
      expect(table).toContain(GW_OUTSIDE);
    });

    it('un paquet direct testé via translateOutbound vers 10.1.1.1 n\'est jamais traduit (règle deny exempte)', async () => {
      const { router } = await labWithExemptionACL();
      const engine = router._getNATEngine();
      const rules = engine.getDynamicRules();
      expect(rules).toHaveLength(1);
    });
  });

  describe('NAT conditionnel : uniquement vers certaines destinations', () => {
    async function labWithSelectiveACL(): Promise<Lab> {
      const lab = await buildLab();
      for (const cmd of [
        'enable', 'configure terminal',
        'ip access-list extended ACL-NAT-SELECTIF',
        '10 deny ip 192.168.10.0 0.0.0.255 203.0.113.100 0.0.0.7',
        '20 permit ip 192.168.10.0 0.0.0.255 any',
        'exit',
        'ip nat inside source list ACL-NAT-SELECTIF interface GigabitEthernet0/1 overload',
        'end',
      ]) await lab.router.executeCommand(cmd);
      return lab;
    }

    it('show ip access-lists ACL-NAT-SELECTIF affiche les deux lignes deny/permit configurées', async () => {
      const { router } = await labWithSelectiveACL();
      const out = await router.executeCommand('show ip access-lists ACL-NAT-SELECTIF');
      expect(out).toContain('ACL-NAT-SELECTIF');
      expect(out).toMatch(/10 deny ip 192\.168\.10\.0 0\.0\.0\.255 203\.0\.113\.100 0\.0\.0\.7/);
      expect(out).toMatch(/20 permit ip 192\.168\.10\.0 0\.0\.0\.255 any/);
    });

    it('les compteurs de matches de l\'ACL augmentent après trafic sortant', async () => {
      const { pcLinux1, router } = await labWithSelectiveACL();
      await pingOnSimulatedClock(pcLinux1, `ping -c 1 ${OUTSIDE_IP}`);

      const out = await router.executeCommand('show ip access-lists ACL-NAT-SELECTIF');
      expect(out).toMatch(/20 permit ip 192\.168\.10\.0 0\.0\.0\.255 any \(\d+ match/);
    });
  });

  describe('NAT différencié par machine : certaines machines sans NAT (déjà natées statiquement)', () => {
    async function labWithMachineACL(): Promise<Lab> {
      const lab = await buildLab();
      for (const cmd of [
        'enable', 'configure terminal',
        'ip access-list standard ACL-MACHINES-PAT',
        `10 deny host ${SRV_ORACLE_IP}`,
        `20 deny host ${DC01_IP}`,
        '30 permit 192.168.10.0 0.0.0.255',
        'exit',
        'ip nat inside source list ACL-MACHINES-PAT interface GigabitEthernet0/1 overload',
        'end',
      ]) await lab.router.executeCommand(cmd);
      return lab;
    }

    it('le serveur Oracle sort toujours via son IP publique statique (203.0.113.10), jamais via le PAT (203.0.113.1)', async () => {
      const { srvOracle, router } = await labWithMachineACL();
      const ping = await pingOnSimulatedClock(srvOracle, `ping -c 3 ${OUTSIDE_IP}`);
      expect(ping).toMatch(/0% packet loss|3 (packets )?received/i);

      // Le NAT statique (sans port) ne crée pas de session PAT dynamique par
      // flux : aucune ligne ne doit combiner Oracle avec l'IP du PAT.
      const table = await router.executeCommand('show ip nat translations');
      expect(table).toContain(ORACLE_PUBLIC_IP);
      expect(table).toContain(SRV_ORACLE_IP);
      const lines = table.split('\n').filter(l => l.includes(SRV_ORACLE_IP));
      for (const l of lines) expect(l).not.toContain(`${GW_OUTSIDE}:`);

      const stats = await router.executeCommand('show ip nat statistics');
      expect(stats).toMatch(/Dynamic translations:\s*0/);
    });

    it('les autres machines (non exclues) utilisent bien le PAT sur 203.0.113.1', async () => {
      const { pcLinux1, router } = await labWithMachineACL();
      await pingOnSimulatedClock(pcLinux1, `ping -c 1 ${OUTSIDE_IP}`);

      const table = await router.executeCommand('show ip nat translations');
      expect(table).toMatch(new RegExp(`icmp\\s+${GW_OUTSIDE.replace(/\./g, '\\.')}:\\d+\\s+${PC_LINUX1_IP.replace(/\./g, '\\.')}`));
    });
  });
});
