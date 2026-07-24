/**
 * Scénario 7 (Cisco) — NAT et VPN IPsec : exemption NAT et interaction.
 *
 * Transcription littérale et fidèle : PAT (LAN Mandeng → Internet) et
 * tunnel IPsec site-à-site (LAN Mandeng ↔ LAN partenaire 10.50.0.0/24)
 * coexistant sur le même routeur, ACL-NAT-GLOBAL avec exemption
 * explicite du trafic VPN (`deny` vers le réseau distant avant le
 * `permit ip ... any` du PAT), et vérification que le trafic chiffré
 * transite (`show crypto ipsec sa`, compteurs `#pkts encaps/decaps`)
 * sans jamais apparaître dans la table NAT. `crypto isakmp nat
 * keepalive` est vérifié comme acceptée pour le cas où le routeur est
 * lui-même derrière un NAT amont (NAT-T, déjà couvert en profondeur
 * par ipsec-nat-dpd.test.ts).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { Cable } from '@/network/hardware/Cable';
import { resetCounters, MACAddress } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';

interface Lab {
  rMandeng: CiscoRouter;
  rPartner: CiscoRouter;
  pcLinux1: LinuxPC;
  pcPartner: LinuxPC;
}

async function buildLab(): Promise<Lab> {
  const rMandeng = new CiscoRouter('R-Mandeng');
  const rPartner = new CiscoRouter('R-Partner');
  const pcLinux1 = new LinuxPC('linux-pc', 'pc-linux-1');
  const pcPartner = new LinuxPC('linux-pc', 'pc-partner');

  new Cable('lan-mandeng').connect(pcLinux1.getPort('eth0')!, rMandeng.getPort('GigabitEthernet0/0')!);
  new Cable('wan').connect(rMandeng.getPort('GigabitEthernet0/1')!, rPartner.getPort('GigabitEthernet0/1')!);
  new Cable('lan-partner').connect(pcPartner.getPort('eth0')!, rPartner.getPort('GigabitEthernet0/0')!);

  await rMandeng.executeCommand('enable');
  await rMandeng.executeCommand('configure terminal');
  await rMandeng.executeCommand('interface GigabitEthernet0/0');
  await rMandeng.executeCommand('ip address 192.168.10.254 255.255.255.0');
  await rMandeng.executeCommand('ip nat inside');
  await rMandeng.executeCommand('no shutdown');
  await rMandeng.executeCommand('exit');
  await rMandeng.executeCommand('interface GigabitEthernet0/1');
  await rMandeng.executeCommand('ip address 203.0.113.1 255.255.255.252');
  await rMandeng.executeCommand('ip nat outside');
  await rMandeng.executeCommand('no shutdown');
  await rMandeng.executeCommand('exit');

  await rMandeng.executeCommand('crypto isakmp policy 10');
  await rMandeng.executeCommand('encryption aes 256');
  await rMandeng.executeCommand('hash sha256');
  await rMandeng.executeCommand('authentication pre-share');
  await rMandeng.executeCommand('group 14');
  await rMandeng.executeCommand('exit');
  await rMandeng.executeCommand('crypto isakmp key VPN@Mandeng2025 address 203.0.113.2');
  await rMandeng.executeCommand('crypto isakmp nat keepalive 20');

  await rMandeng.executeCommand('crypto ipsec transform-set TS-MANDENG esp-aes 256 esp-sha256-hmac');
  await rMandeng.executeCommand('mode tunnel');
  await rMandeng.executeCommand('exit');

  await rMandeng.executeCommand('ip access-list extended ACL-VPN-TRAFIC');
  await rMandeng.executeCommand('10 permit ip 192.168.10.0 0.0.0.255 10.50.0.0 0.0.0.255');
  await rMandeng.executeCommand('exit');

  await rMandeng.executeCommand('crypto map MAP-VPN 10 ipsec-isakmp');
  await rMandeng.executeCommand('set peer 203.0.113.2');
  await rMandeng.executeCommand('set transform-set TS-MANDENG');
  await rMandeng.executeCommand('match address ACL-VPN-TRAFIC');
  await rMandeng.executeCommand('exit');

  await rMandeng.executeCommand('interface GigabitEthernet0/1');
  await rMandeng.executeCommand('crypto map MAP-VPN');
  await rMandeng.executeCommand('exit');

  await rMandeng.executeCommand('ip access-list extended ACL-NAT-GLOBAL');
  await rMandeng.executeCommand('10 deny ip 192.168.10.0 0.0.0.255 10.50.0.0 0.0.0.255');
  await rMandeng.executeCommand('20 permit ip 192.168.10.0 0.0.0.255 any');
  await rMandeng.executeCommand('exit');
  await rMandeng.executeCommand('ip nat inside source list ACL-NAT-GLOBAL interface GigabitEthernet0/1 overload');
  await rMandeng.executeCommand('ip route 10.50.0.0 255.255.255.0 203.0.113.2');
  await rMandeng.executeCommand('end');

  await rPartner.executeCommand('enable');
  await rPartner.executeCommand('configure terminal');
  await rPartner.executeCommand('interface GigabitEthernet0/0');
  await rPartner.executeCommand('ip address 10.50.0.254 255.255.255.0');
  await rPartner.executeCommand('no shutdown');
  await rPartner.executeCommand('exit');
  await rPartner.executeCommand('interface GigabitEthernet0/1');
  await rPartner.executeCommand('ip address 203.0.113.2 255.255.255.252');
  await rPartner.executeCommand('no shutdown');
  await rPartner.executeCommand('exit');

  await rPartner.executeCommand('crypto isakmp policy 10');
  await rPartner.executeCommand('encryption aes 256');
  await rPartner.executeCommand('hash sha256');
  await rPartner.executeCommand('authentication pre-share');
  await rPartner.executeCommand('group 14');
  await rPartner.executeCommand('exit');
  await rPartner.executeCommand('crypto isakmp key VPN@Mandeng2025 address 203.0.113.1');

  await rPartner.executeCommand('crypto ipsec transform-set TS-MANDENG esp-aes 256 esp-sha256-hmac');
  await rPartner.executeCommand('mode tunnel');
  await rPartner.executeCommand('exit');

  await rPartner.executeCommand('ip access-list extended ACL-VPN-TRAFIC');
  await rPartner.executeCommand('10 permit ip 10.50.0.0 0.0.0.255 192.168.10.0 0.0.0.255');
  await rPartner.executeCommand('exit');

  await rPartner.executeCommand('crypto map MAP-VPN 10 ipsec-isakmp');
  await rPartner.executeCommand('set peer 203.0.113.1');
  await rPartner.executeCommand('set transform-set TS-MANDENG');
  await rPartner.executeCommand('match address ACL-VPN-TRAFIC');
  await rPartner.executeCommand('exit');

  await rPartner.executeCommand('interface GigabitEthernet0/1');
  await rPartner.executeCommand('crypto map MAP-VPN');
  await rPartner.executeCommand('exit');
  await rPartner.executeCommand('ip route 192.168.10.0 255.255.255.0 203.0.113.1');
  await rPartner.executeCommand('end');

  await pcLinux1.executeCommand('sudo ip addr add 192.168.10.101/24 dev eth0');
  await pcLinux1.executeCommand('sudo ip route add default via 192.168.10.254');
  await pcPartner.executeCommand('sudo ip addr add 10.50.0.10/24 dev eth0');
  await pcPartner.executeCommand('sudo ip route add default via 10.50.0.254');

  return { rMandeng, rPartner, pcLinux1, pcPartner };
}

describe('Scénario 7 (Cisco) — NAT et VPN IPsec : exemption NAT et interaction', () => {
  beforeEach(() => {
    resetCounters();
    MACAddress.resetCounter();
    resetDeviceCounters();
    Logger.reset();
    EquipmentRegistry.resetInstance();
  });

  describe('configuration NAT avec exemption VPN', () => {
    it('le tunnel IPsec est établi (QM_IDLE) et le trafic vers le LAN partenaire chiffré transite avec des compteurs non nuls', async () => {
      const { rMandeng, pcLinux1 } = await buildLab();
      const pingOut = await pcLinux1.executeCommand('ping -c 3 10.50.0.10');
      expect(pingOut).toContain('0% packet loss');

      const isakmp = await rMandeng.executeCommand('show crypto isakmp sa');
      expect(isakmp).toContain('QM_IDLE');

      const ipsecSA = await rMandeng.executeCommand('show crypto ipsec sa');
      expect(ipsecSA).toContain('#pkts encaps: 3');
      expect(ipsecSA).toContain('#pkts decaps: 3');
    });

    it('le trafic vers le réseau VPN distant (10.50.0.0/24) n\'apparaît jamais dans show ip nat translations', async () => {
      const { rMandeng, pcLinux1 } = await buildLab();
      await pcLinux1.executeCommand('ping -c 3 10.50.0.10');

      const table = await rMandeng.executeCommand('show ip nat translations');
      expect(table).not.toContain('10.50.0.10');
    });

    it('ACL-NAT-GLOBAL est correctement configurée : exemption VPN (deny) avant l\'autorisation générale (permit any)', async () => {
      const { rMandeng } = await buildLab();
      const acl = await rMandeng.executeCommand('show ip access-lists ACL-NAT-GLOBAL');
      expect(acl).toMatch(/10 deny ip 192\.168\.10\.0 0\.0\.0\.255 10\.50\.0\.0 0\.0\.0\.255/);
      expect(acl).toMatch(/20 permit ip 192\.168\.10\.0 0\.0\.0\.255 any/);
    });
  });

  describe('NAT-T pour routeur derrière un NAT upstream (configuration)', () => {
    it('crypto isakmp nat keepalive 20 est accepté et visible dans la configuration ISAKMP', async () => {
      const { rMandeng } = await buildLab();
      const isakmpDetail = await rMandeng.executeCommand('show crypto isakmp sa detail');
      expect(isakmpDetail).not.toMatch(/not recognized/i);
    });
  });
});
