/**
 * Scénario 10 (Cisco) — NAT avec timeout configuré et gestion des
 * entrées expirées.
 *
 * Transcription littérale et fidèle : lecture/configuration des
 * timeouts NAT par protocole (`ip nat translation tcp-timeout/
 * udp-timeout/icmp-timeout/syn-timeout`), cycle de vie d'une entrée
 * (apparition immédiate, expiration automatique après le timeout
 * configuré via `purgeStale`), et lecture du temps restant dans
 * `show ip nat translations verbose`.
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
const PC1_IP = '192.168.10.101';

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

  const m = new SubnetMask('255.255.255.0');
  pc1.getPorts()[0].configureIP(new IPAddress(PC1_IP), m);
  pc1.setDefaultGateway(new IPAddress(GW_INSIDE));
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
    'access-list 1 permit 192.168.10.0 0.0.0.255',
    'ip nat inside source list 1 interface GigabitEthernet0/1 overload',
    `ip route 0.0.0.0 0.0.0.0 GigabitEthernet0/1`,
    'end',
  ]) await router.executeCommand(cmd);

  return { pc1, router };
}

describe('Scénario 10 (Cisco) — timeouts NAT et cycle de vie des entrées', () => {
  beforeEach(() => {
    resetCounters();
    MACAddress.resetCounter();
    resetDeviceCounters();
    Logger.reset();
    EquipmentRegistry.resetInstance();
  });

  describe('timeouts NAT par défaut et configuration', () => {
    it('les timeouts par défaut correspondent aux valeurs standard IOS (tcp 86400s, udp 300s, icmp 60s)', async () => {
      const { router } = await buildLab();
      const t = router._getNATEngine().getTimeouts();
      expect(t.tcp).toBe(86_400_000);
      expect(t.udp).toBe(300_000);
      expect(t.icmp).toBe(60_000);
    });

    it('ip nat translation tcp-timeout/udp-timeout/icmp-timeout/syn-timeout appliquent les valeurs personnalisées', async () => {
      const { router } = await buildLab();
      await router.executeCommand('configure terminal');
      await router.executeCommand('ip nat translation tcp-timeout 3600');
      await router.executeCommand('ip nat translation udp-timeout 120');
      await router.executeCommand('ip nat translation icmp-timeout 30');
      await router.executeCommand('ip nat translation syn-timeout 30');
      await router.executeCommand('end');

      const t = router._getNATEngine().getTimeouts();
      expect(t.tcp).toBe(3600 * 1000);
      expect(t.udp).toBe(120 * 1000);
      expect(t.icmp).toBe(30 * 1000);
      expect(t.tcpHalfOpen).toBe(30 * 1000);
    });

    it('show running-config reflète les timeouts non-standards configurés', async () => {
      const { router } = await buildLab();
      await router.executeCommand('configure terminal');
      await router.executeCommand('ip nat translation tcp-timeout 3600');
      await router.executeCommand('ip nat translation icmp-timeout 30');
      await router.executeCommand('end');

      const out = await router.executeCommand('show running-config | include ip nat translation');
      expect(out).toContain('ip nat translation tcp-timeout 3600');
      expect(out).toContain('ip nat translation icmp-timeout 30');
    });
  });

  describe('observation du cycle de vie d\'une entrée NAT', () => {
    it('une entrée ICMP créée par un ping unique est visible immédiatement dans la table', async () => {
      const { pc1, router } = await buildLab();
      await pc1.executeCommand(`ping -c 1 ${OUTSIDE_IP}`);

      const out = await router.executeCommand('show ip nat translations');
      expect(out).toContain(PC1_IP);
    });

    it('l\'entrée ICMP expire et disparaît automatiquement après le icmp-timeout configuré (30s)', async () => {
      const { pc1, router } = await buildLab();
      await router.executeCommand('configure terminal');
      await router.executeCommand('ip nat translation icmp-timeout 30');
      await router.executeCommand('end');

      await pc1.executeCommand(`ping -c 1 ${OUTSIDE_IP}`);
      let out = await router.executeCommand('show ip nat translations');
      expect(out).toContain(PC1_IP);

      const engine = router._getNATEngine();
      engine.purgeStale(0); // force l'expiration, au-delà du timeout ICMP de 30s configuré
      out = await router.executeCommand('show ip nat translations');
      expect(out).not.toContain(PC1_IP);
    });

    it('show ip nat translations verbose affiche un temps restant réel (left:N), pas un espace réservé statique "--"', async () => {
      const { pc1, router } = await buildLab();
      await router.executeCommand('configure terminal');
      await router.executeCommand('ip nat translation icmp-timeout 30');
      await router.executeCommand('end');
      await pc1.executeCommand(`ping -c 1 ${OUTSIDE_IP}`);

      const out = await router.executeCommand('show ip nat translations verbose');
      expect(out).toContain(PC1_IP);
      expect(out).not.toMatch(/left:\s*--/);
    });
  });

  describe('commande d\'inspection show ip nat translations timeout', () => {
    it('affiche les timeouts par protocole configurés (tcp/udp/icmp/dns/syn/finrst)', async () => {
      const { router } = await buildLab();
      const out = await router.executeCommand('show ip nat translations timeout');
      expect(out).toMatch(/tcp-timeout/);
      expect(out).toMatch(/udp-timeout/);
      expect(out).toMatch(/icmp-timeout/);
      expect(out).toMatch(/dns-timeout/);
      expect(out).toMatch(/syn-timeout/);
      expect(out).toMatch(/finrst-timeout/);
    });
  });
});
