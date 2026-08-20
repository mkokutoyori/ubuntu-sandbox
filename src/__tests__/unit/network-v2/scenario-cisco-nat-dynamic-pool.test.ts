/**
 * Scénario 3 (Cisco) — NAT dynamique avec pool d'adresses publiques.
 *
 * Transcription littérale et fidèle : `ip nat pool POOL-PUBLIC
 * 203.0.113.20 203.0.113.24 netmask 255.255.255.0` (5 adresses), ACL
 * ACL-NAT-DYNAMIQUE, `ip nat inside source list ACL-NAT-DYNAMIQUE pool
 * POOL-PUBLIC` (SANS overload — une IP privée pour une IP publique du
 * pool), allocation d'une IP distincte par machine, épuisement du pool
 * au-delà de 5 machines simultanées (compteur `misses`, drop silencieux
 * côté client), et bascule vers `overload` pour absorber le dépassement.
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
const POOL_START = '203.0.113.20';
const POOL_END = '203.0.113.24';

interface Lab {
  pcs: LinuxPC[];
  router: CiscoRouter;
}

async function buildLab(hostCount: number): Promise<Lab> {
  const lanSw = new GenericSwitch('switch-generic', 'lan-sw', 16, 0, 0);
  const wanSw = new GenericSwitch('switch-generic', 'wan-sw', 8, 0, 0);
  const router = new CiscoRouter('router', 0, 0);
  const outside = new LinuxPC('linux-pc', 'outside', 0, 0);
  const pcs: LinuxPC[] = [];

  new Cable('d').connect(lanSw.getPorts()[15], router.getPort('GigabitEthernet0/0')!);
  new Cable('e').connect(router.getPort('GigabitEthernet0/1')!, wanSw.getPorts()[0]);
  new Cable('f').connect(wanSw.getPorts()[1], outside.getPort('eth0')!);

  const m = new SubnetMask('255.255.255.0');
  outside.getPorts()[0].configureIP(new IPAddress(OUTSIDE_IP), new SubnetMask('255.255.255.252'));
  outside.setDefaultGateway(new IPAddress(GW_OUTSIDE));

  for (let i = 0; i < hostCount; i++) {
    const pc = new LinuxPC('linux-pc', `pc-${i + 1}`, 0, 0);
    new Cable(`h${i}`).connect(pc.getPort('eth0')!, lanSw.getPorts()[i]);
    pc.getPorts()[0].configureIP(new IPAddress(`192.168.10.${101 + i}`), m);
    pc.setDefaultGateway(new IPAddress(GW_INSIDE));
    pcs.push(pc);
  }

  for (const cmd of [
    'enable',
    'configure terminal',
    `ip nat pool POOL-PUBLIC ${POOL_START} ${POOL_END} netmask 255.255.255.0`,
    'ip access-list standard ACL-NAT-DYNAMIQUE',
    '10 permit 192.168.10.0 0.0.0.255',
    'exit',
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
    'ip nat inside source list ACL-NAT-DYNAMIQUE pool POOL-PUBLIC',
    `ip route 0.0.0.0 0.0.0.0 GigabitEthernet0/1`,
    'end',
  ]) await router.executeCommand(cmd);

  return { pcs, router };
}

describe('Scénario 3 (Cisco) — NAT dynamique avec pool d\'adresses publiques', () => {
  beforeEach(() => {
    resetCounters();
    MACAddress.resetCounter();
    resetDeviceCounters();
    Logger.reset();
    EquipmentRegistry.resetInstance();
  });

  describe('configuration du NAT dynamique avec pool', () => {
    it('ip nat pool POOL-PUBLIC est enregistré avec ses 5 adresses (203.0.113.20-24)', async () => {
      const { router } = await buildLab(1);
      const pool = router._getNATEngine().getPool('POOL-PUBLIC');
      expect(pool).toBeDefined();
      expect(pool!.startIP).toBe(POOL_START);
      expect(pool!.endIP).toBe(POOL_END);
    });

    it('ip nat inside source list ACL-NAT-DYNAMIQUE pool POOL-PUBLIC crée une règle "pool" (SANS overload)', async () => {
      const { router } = await buildLab(1);
      const rules = router._getNATEngine().getDynamicRules();
      expect(rules).toHaveLength(1);
      expect(rules[0].type).toBe('pool');
      expect(rules[0].type).not.toBe('overload');
    });
  });

  describe('allocation dynamique des adresses', () => {
    it('5 machines internes reçoivent chacune une adresse distincte du pool', async () => {
      const { pcs, router } = await buildLab(5);
      for (const pc of pcs) await pc.executeCommand(`ping -c 1 ${OUTSIDE_IP}`);

      const table = await router.executeCommand('show ip nat translations');
      const globals = new Set<string>();
      const rx = /^icmp\s+(\d+\.\d+\.\d+\.\d+):/gm;
      let m: RegExpExecArray | null;
      while ((m = rx.exec(table)) !== null) globals.add(m[1]);
      expect(globals.size).toBe(5);
      for (const ip of globals) {
        expect(ip >= POOL_START && ip <= POOL_END).toBe(true);
      }
    });

    it('le pool affiche 5 adresses allouées (100%) une fois les 5 machines actives', async () => {
      const { pcs, router } = await buildLab(5);
      for (const pc of pcs) await pc.executeCommand(`ping -c 1 ${OUTSIDE_IP}`);

      const pool = router._getNATEngine().getPool('POOL-PUBLIC');
      const sessions = router._getNATEngine().getSessions().filter(s => {
        const n = (ip: string) => ip.split('.').reduce((a, x) => (a << 8) + parseInt(x, 10), 0) >>> 0;
        return n(s.globalIP) >= n(pool!.startIP) && n(s.globalIP) <= n(pool!.endIP);
      });
      expect(sessions.length).toBe(5);
    });
  });

  describe('comportement à l\'épuisement du pool', () => {
    it('une 6e machine ne reçoit aucune traduction une fois le pool de 5 adresses épuisé', async () => {
      const { pcs, router } = await buildLab(6);
      for (const pc of pcs.slice(0, 5)) await pc.executeCommand(`ping -c 1 ${OUTSIDE_IP}`);
      await pcs[5].executeCommand(`ping -c 1 ${OUTSIDE_IP}`);

      const table = await router.executeCommand('show ip nat translations');
      expect(table).not.toContain('192.168.10.106');
    });

    it('le compteur "misses" du pool s\'incrémente à chaque tentative d\'allocation échouée', async () => {
      const { pcs, router } = await buildLab(6);
      for (const pc of pcs.slice(0, 5)) await pc.executeCommand(`ping -c 1 ${OUTSIDE_IP}`);
      const engine = router._getNATEngine();
      const missesBefore = engine.getCounters().misses;

      await pcs[5].executeCommand(`ping -c 1 ${OUTSIDE_IP}`);

      expect(engine.getCounters().misses).toBeGreaterThan(missesBefore);
    });

    it('ajouter "overload" à la règle absorbe le dépassement : la 6e machine obtient désormais une traduction (PAT sur la dernière adresse)', async () => {
      const { pcs, router } = await buildLab(6);
      for (const pc of pcs.slice(0, 5)) await pc.executeCommand(`ping -c 1 ${OUTSIDE_IP}`);

      await router.executeCommand('configure terminal');
      await router.executeCommand('no ip nat inside source list ACL-NAT-DYNAMIQUE pool POOL-PUBLIC');
      await router.executeCommand('ip nat inside source list ACL-NAT-DYNAMIQUE pool POOL-PUBLIC overload');
      await router.executeCommand('end');

      await pcs[5].executeCommand(`ping -c 1 ${OUTSIDE_IP}`);

      const table = await router.executeCommand('show ip nat translations');
      expect(table).toContain('192.168.10.106');
    });
  });
});
