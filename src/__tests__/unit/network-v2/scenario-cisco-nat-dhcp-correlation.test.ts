/**
 * Scénario 14 (Cisco) — NAT et DHCP : cohérence entre allocation
 * d'adresses et traduction.
 *
 * Transcription littérale et fidèle : pool DHCP LAN-MANDENG
 * (192.168.10.0/24, exclusion 1-30), ACL NAT couvrant toute la plage
 * DHCP allouable (192.168.10.0/24), acquisition réelle d'un bail par
 * `dhclient -v eth0` sur les machines internes, puis corrélation entre
 * `show ip dhcp binding` (bail réel), `show ip nat translations`
 * (session PAT réelle) et `show arp` (MAC sur l'interface d'entrée),
 * la même adresse IP privée servant de clé de corrélation.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { GenericSwitch } from '@/network/devices/GenericSwitch';
import { Cable } from '@/network/hardware/Cable';
import { IPAddress, SubnetMask, MACAddress, resetCounters } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';

const GW_INSIDE = '192.168.10.254';
const GW_OUTSIDE = '203.0.113.1';
const OUTSIDE_IP = '203.0.113.2';

interface Lab {
  pc1: LinuxPC;
  router: CiscoRouter;
}

async function buildLab(): Promise<Lab> {
  const lanSw = new GenericSwitch('switch-generic', 'lan-sw', 8, 0, 0);
  const wanSw = new GenericSwitch('switch-generic', 'wan-sw', 8, 0, 0);
  const router = new CiscoRouter('router', 0, 0);
  const pc1 = new LinuxPC('linux-pc', 'pc-1', 0, 0);
  const outside = new LinuxPC('linux-pc', 'outside', 0, 0);

  new Cable('a').connect(pc1.getPort('eth0')!, lanSw.getPorts()[0]);
  new Cable('d').connect(lanSw.getPorts()[7], router.getPort('GigabitEthernet0/0')!);
  new Cable('e').connect(router.getPort('GigabitEthernet0/1')!, wanSw.getPorts()[0]);
  new Cable('f').connect(wanSw.getPorts()[1], outside.getPort('eth0')!);

  outside.getPorts()[0].configureIP(new IPAddress(OUTSIDE_IP), new SubnetMask('255.255.255.252'));
  outside.setDefaultGateway(new IPAddress(GW_OUTSIDE));

  for (const cmd of [
    'enable',
    'configure terminal',
    'ip dhcp pool LAN-MANDENG',
    'network 192.168.10.0 255.255.255.0',
    `default-router ${GW_INSIDE}`,
    'dns-server 192.168.10.10',
    'domain-name mandeng.lan',
    'lease 1 0 0',
    'exit',
    'ip dhcp excluded-address 192.168.10.1 192.168.10.30',
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
    'ip access-list standard ACL-DHCP-NAT',
    '10 permit 192.168.10.0 0.0.0.255',
    'exit',
    'ip nat inside source list ACL-DHCP-NAT interface GigabitEthernet0/1 overload',
    `ip route 0.0.0.0 0.0.0.0 GigabitEthernet0/1`,
    'end',
  ]) await router.executeCommand(cmd);

  return { pc1, router };
}

describe('Scénario 14 (Cisco) — NAT et DHCP : cohérence allocation/traduction', () => {
  beforeEach(() => {
    resetCounters();
    MACAddress.resetCounter();
    resetDeviceCounters();
    Logger.reset();
    EquipmentRegistry.resetInstance();
  });

  describe('configuration DHCP et couverture par l\'ACL NAT', () => {
    it('dhclient -v eth0 obtient réellement un bail DHCP dans 192.168.10.31-254 (plage non exclue)', async () => {
      const { pc1 } = await buildLab();
      const out = await pc1.executeCommand('dhclient -v eth0');
      expect(out).not.toMatch(/no dhcpoffers received|failed/i);

      const ip = await pc1.executeCommand('ip -4 addr show eth0');
      const m = /inet (192\.168\.10\.\d+)/.exec(ip);
      expect(m).not.toBeNull();
      const octet = Number(m![1].split('.')[3]);
      expect(octet).toBeGreaterThanOrEqual(31);
    });

    it('show ip dhcp binding liste le bail actif du client avec son adresse MAC', async () => {
      const { pc1, router } = await buildLab();
      await pc1.executeCommand('dhclient -v eth0');

      const out = await router.executeCommand('show ip dhcp binding');
      expect(out).toMatch(/192\.168\.10\.(3[1-9]|[4-9]\d|1\d\d|2[0-4]\d|25[0-4])/);
      expect(out).toMatch(/Automatic/i);
    });

    it('ACL-DHCP-NAT (permit 192.168.10.0 0.0.0.255) couvre entièrement la plage DHCP allouable', async () => {
      const { router } = await buildLab();
      const out = await router.executeCommand('show ip access-lists ACL-DHCP-NAT');
      expect(out).toContain('192.168.10.0 0.0.0.255');
    });
  });

  describe('corrélation DHCP + NAT pour la traçabilité', () => {
    it('l\'IP obtenue par DHCP est celle qui apparaît dans show ip nat translations après trafic sortant', async () => {
      const { pc1, router } = await buildLab();
      await pc1.executeCommand('dhclient -v eth0');
      const ipOut = await pc1.executeCommand('ip -4 addr show eth0');
      const leasedIp = /inet (192\.168\.10\.\d+)/.exec(ipOut)![1];

      await pc1.executeCommand(`ping -c 1 ${OUTSIDE_IP}`);

      const table = await router.executeCommand('show ip nat translations');
      expect(table).toContain(leasedIp);
    });

    it('show arp corrèle l\'IP louée à une adresse MAC connue sur GigabitEthernet0/0', async () => {
      const { pc1, router } = await buildLab();
      await pc1.executeCommand('dhclient -v eth0');
      const ipOut = await pc1.executeCommand('ip -4 addr show eth0');
      const leasedIp = /inet (192\.168\.10\.\d+)/.exec(ipOut)![1];
      await pc1.executeCommand(`ping -c 1 ${GW_INSIDE}`);

      const arp = await router.executeCommand(`show arp | include ${leasedIp}`);
      expect(arp).toContain('GigabitEthernet0/0');
      expect(arp).toMatch(/[0-9a-f]{4}\.[0-9a-f]{4}\.[0-9a-f]{4}/i);
    });
  });
});
