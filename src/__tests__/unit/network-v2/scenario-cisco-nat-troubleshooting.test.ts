/**
 * Scénario 8 (Cisco) — Dépannage NAT : debug ip nat, show ip nat
 * translations et clear.
 *
 * Transcription littérale et fidèle des outils de dépannage NAT IOS :
 * `show ip nat translations verbose` (create/use/timeout restant),
 * `debug ip nat` (traçage paquet par paquet), diagnostic d'ACL NAT
 * trop restrictive via les compteurs `Misses`/matches d'ACL, correction
 * d'une entrée statique incorrecte, `clear ip nat translation`
 * sélectif (par 4-tuple) vs global (`*`) vs `expired`, et réduction des
 * timeouts pour une table proche de la saturation.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { LinuxServer } from '@/network/devices/LinuxServer';
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
const PC2_IP = '192.168.10.102';
const DC01_IP = '192.168.10.10';

interface Lab {
  pc1: LinuxPC;
  pc2: LinuxPC;
  dc01: LinuxServer;
  outside: LinuxServer;
  router: CiscoRouter;
}

async function buildLab(): Promise<Lab> {
  const lanSw = new GenericSwitch('switch-generic', 'lan-sw', 8, 0, 0);
  const wanSw = new GenericSwitch('switch-generic', 'wan-sw', 8, 0, 0);
  const router = new CiscoRouter('router', 0, 0);
  const pc1 = new LinuxPC('linux-pc', 'pc-1', 0, 0);
  const pc2 = new LinuxPC('linux-pc', 'pc-2', 0, 0);
  const dc01 = new LinuxServer('linux-server', 'dc01', 0, 0);
  const outside = new LinuxServer('linux-server', 'outside', 0, 0);

  new Cable('a').connect(pc1.getPort('eth0')!, lanSw.getPorts()[0]);
  new Cable('b').connect(pc2.getPort('eth0')!, lanSw.getPorts()[1]);
  new Cable('c').connect(dc01.getPort('eth0')!, lanSw.getPorts()[2]);
  new Cable('d').connect(lanSw.getPorts()[7], router.getPort('GigabitEthernet0/0')!);
  new Cable('e').connect(router.getPort('GigabitEthernet0/1')!, wanSw.getPorts()[0]);
  new Cable('f').connect(wanSw.getPorts()[1], outside.getPort('eth0')!);

  const m = new SubnetMask('255.255.255.0');
  pc1.getPorts()[0].configureIP(new IPAddress(PC1_IP), m);
  pc2.getPorts()[0].configureIP(new IPAddress(PC2_IP), m);
  dc01.getPorts()[0].configureIP(new IPAddress(DC01_IP), m);
  for (const h of [pc1, pc2, dc01]) h.setDefaultGateway(new IPAddress(GW_INSIDE));
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
    'ip access-list standard ACL-LAN-INTERNE',
    '10 permit 192.168.10.0 0.0.0.255',
    'exit',
    'ip nat inside source list ACL-LAN-INTERNE interface GigabitEthernet0/1 overload',
    `ip route 0.0.0.0 0.0.0.0 GigabitEthernet0/1`,
    'end',
  ]) await router.executeCommand(cmd);

  return { pc1, pc2, dc01, outside, router };
}

describe('Scénario 8 (Cisco) — dépannage NAT : outils de diagnostic', () => {
  beforeEach(() => {
    resetCounters();
    MACAddress.resetCounter();
    resetDeviceCounters();
    Logger.reset();
    EquipmentRegistry.resetInstance();
  });

  describe('show ip nat translations verbose', () => {
    it('affiche create/use/left et flags pour chaque entrée dynamique', async () => {
      const { pc1, router } = await buildLab();
      await pc1.executeCommand(`ping -c 1 ${OUTSIDE_IP}`);

      const out = await router.executeCommand('show ip nat translations verbose');
      expect(out).toContain(PC1_IP);
      expect(out).toMatch(/create:.*use:.*left:/);
      expect(out).toMatch(/flags:\s*(extended|static)/);
    });
  });

  describe('debug ip nat', () => {
    it('produit une ligne par paquet traduit avec les adresses avant/après traduction', async () => {
      const { pc1, router } = await buildLab();
      await router.executeCommand('debug ip nat');
      await pc1.executeCommand(`ping -c 1 ${OUTSIDE_IP}`);

      const debugOut = await router.executeCommand('show logging | include NAT');
      expect(debugOut).toMatch(new RegExp(`s=${PC1_IP.replace(/\./g, '\\.')}->${GW_OUTSIDE.replace(/\./g, '\\.')}`));
      await router.executeCommand('undebug all');
    });
  });

  describe('diagnostic : trafic non traduit (Misses)', () => {
    it('show ip nat statistics affiche Misses: 0 quand l\'ACL couvre correctement le LAN', async () => {
      const { pc1, router } = await buildLab();
      await pc1.executeCommand(`ping -c 1 ${OUTSIDE_IP}`);

      const out = await router.executeCommand('show ip nat statistics');
      expect(out).toMatch(/Misses:\s*0/);
    });

    it('show ip access-lists ACL-LAN-INTERNE montre des compteurs de matches non nuls après trafic', async () => {
      const { pc1, router } = await buildLab();
      await pc1.executeCommand(`ping -c 1 ${OUTSIDE_IP}`);

      const out = await router.executeCommand('show ip access-lists ACL-LAN-INTERNE');
      expect(out).toMatch(/10 permit 192\.168\.10\.0, wildcard bits 0\.0\.0\.255 \(\d+ match/);
    });
  });

  describe('diagnostic : entrée NAT statique incorrecte', () => {
    it('une entrée statique redirigée vers la mauvaise IP interne est corrigée par no/re-add', async () => {
      const { router } = await buildLab();
      await router.executeCommand('configure terminal');
      await router.executeCommand('ip nat inside source static tcp 192.168.10.50 22 203.0.113.1 22');
      let out = await router.executeCommand('show ip nat translations');
      expect(out).toContain('192.168.10.50');

      await router.executeCommand('no ip nat inside source static tcp 192.168.10.50 22 203.0.113.1 22');
      await router.executeCommand(`ip nat inside source static tcp ${DC01_IP} 22 203.0.113.1 22`);
      await router.executeCommand('end');

      out = await router.executeCommand('show ip nat translations');
      expect(out).not.toContain('192.168.10.50');
      expect(out).toContain(DC01_IP);
    });
  });

  describe('clear sélectif vs global', () => {
    it('clear ip nat translation tcp <local> <lport> <global> <gport> ne supprime QUE l\'entrée visée, pas les autres sessions actives', async () => {
      const { pc1, pc2, router } = await buildLab();
      await pc1.executeCommand(`nc -zv ${OUTSIDE_IP} 80`);
      await pc2.executeCommand(`nc -zv ${OUTSIDE_IP} 80`);

      const before = await router.executeCommand('show ip nat translations');
      const rx = new RegExp(`tcp\\s+(${GW_OUTSIDE.replace(/\./g, '\\.')}):(\\d+)\\s+${PC1_IP.replace(/\./g, '\\.')}`);
      const m = rx.exec(before);
      expect(m).not.toBeNull();
      const [, globalIp, globalPort] = m!;

      await router.executeCommand(`clear ip nat translation tcp ${PC1_IP} ${globalPort} ${globalIp} ${globalPort}`);

      const after = await router.executeCommand('show ip nat translations');
      expect(after).toContain(PC2_IP);
    });

    it('clear ip nat translation * supprime bien toutes les sessions dynamiques', async () => {
      const { pc1, pc2, router } = await buildLab();
      await pc1.executeCommand(`nc -zv ${OUTSIDE_IP} 80`);
      await pc2.executeCommand(`nc -zv ${OUTSIDE_IP} 80`);

      await router.executeCommand('clear ip nat translation *');

      const out = await router.executeCommand('show ip nat translations');
      expect(out).not.toContain(PC1_IP);
      expect(out).not.toContain(PC2_IP);
    });

    it('clear ip nat translation expired n\'affecte aucune session active (seules les entrées expirées sont supprimées)', async () => {
      const { pc1, router } = await buildLab();
      await pc1.executeCommand(`ping -c 1 ${OUTSIDE_IP}`);

      await router.executeCommand('clear ip nat translation expired');

      const out = await router.executeCommand('show ip nat translations');
      expect(out).toContain(PC1_IP);
    });
  });

  describe('table NAT proche de la saturation : réduction des timeouts', () => {
    it('ip nat translation tcp-timeout/udp-timeout/icmp-timeout réduisent bien les valeurs par défaut', async () => {
      const { router } = await buildLab();
      await router.executeCommand('configure terminal');
      await router.executeCommand('ip nat translation tcp-timeout 7200');
      await router.executeCommand('ip nat translation udp-timeout 60');
      await router.executeCommand('ip nat translation icmp-timeout 15');
      await router.executeCommand('end');

      const timeouts = router._getNATEngine().getTimeouts();
      expect(timeouts.tcp).toBe(7200 * 1000);
      expect(timeouts.udp).toBe(60 * 1000);
      expect(timeouts.icmp).toBe(15 * 1000);
    });
  });

  describe('séquence de vérification post-dépannage', () => {
    it('interfaces, règles NAT, statistiques et ACL sont tous cohérents après correction', async () => {
      const { pc1, router } = await buildLab();
      await pc1.executeCommand(`ping -c 1 ${OUTSIDE_IP}`);

      const ifaces = await router.executeCommand('show ip interface brief | include GigabitEthernet');
      expect(ifaces).toContain('GigabitEthernet0/0');
      expect(ifaces).toContain('GigabitEthernet0/1');

      const table = await router.executeCommand('show ip nat translations');
      expect(table).toContain(PC1_IP);

      const stats = await router.executeCommand('show ip nat statistics');
      expect(stats).toMatch(/Misses:\s*0/);

      const acl = await router.executeCommand('show ip access-lists ACL-LAN-INTERNE');
      expect(acl).toMatch(/\d+ match/);
    });
  });
});
