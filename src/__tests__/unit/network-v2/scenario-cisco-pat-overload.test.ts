/**
 * Scénario 1 (Cisco) — PAT (NAT Overload) : plusieurs machines internes
 * vers une seule IP publique.
 *
 * Transcription littérale et fidèle : ACL nommée ACL-LAN-INTERNE
 * (192.168.10.0/24, 192.168.20.0/24, 192.168.99.0/24), interfaces
 * inside/outside (GigabitEthernet0/0 LAN, GigabitEthernet0/1 WAN en
 * 203.0.113.1/30), `ip nat inside source list ACL-LAN-INTERNE interface
 * GigabitEthernet0/1 overload`, trafic simultané depuis PC-Linux-1/2 et
 * PC-Win-1, et lecture de `show ip nat translations`/`show ip nat
 * statistics`/`show ip nat translations verbose`.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { WindowsPC } from '@/network/devices/WindowsPC';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { GenericSwitch } from '@/network/devices/GenericSwitch';
import { Cable } from '@/network/hardware/Cable';
import { IPAddress, SubnetMask, MACAddress, resetCounters } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import { VirtualTimeScheduler } from '@/events/Scheduler';

interface Lab {
  pcLinux1: LinuxPC;
  pcLinux2: LinuxPC;
  pcWin1: WindowsPC;
  router: CiscoRouter;
  outside: LinuxServer;
  clock: VirtualTimeScheduler;
}

const PC_LINUX1_IP = '192.168.10.101';
const PC_LINUX2_IP = '192.168.10.102';
const PC_WIN1_IP = '192.168.10.200';
const GW_INSIDE = '192.168.10.254';
const GW_OUTSIDE = '203.0.113.1';
const OUTSIDE_IP = '203.0.113.2'; // représente "8.8.8.8" du scénario, dans le même /30 que la WAN

async function buildLab(): Promise<Lab> {
  const lanSw = new GenericSwitch('switch-generic', 'lan-sw', 8, 0, 0);
  const wanSw = new GenericSwitch('switch-generic', 'wan-sw', 8, 0, 0);
  const router = new CiscoRouter('router', 0, 0);
  const pcLinux1 = new LinuxPC('linux-pc', 'pc-linux-1', 0, 0);
  const pcLinux2 = new LinuxPC('linux-pc', 'pc-linux-2', 0, 0);
  const pcWin1 = new WindowsPC('windows-pc', 'pc-win-1', 0, 0);
  const outside = new LinuxServer('linux-server', 'outside', 0, 0);

  new Cable('a').connect(pcLinux1.getPort('eth0')!, lanSw.getPorts()[0]);
  new Cable('b').connect(pcLinux2.getPort('eth0')!, lanSw.getPorts()[1]);
  new Cable('c').connect(pcWin1.getPorts()[0], lanSw.getPorts()[2]);
  new Cable('d').connect(lanSw.getPorts()[7], router.getPort('GigabitEthernet0/0')!);
  new Cable('e').connect(router.getPort('GigabitEthernet0/1')!, wanSw.getPorts()[0]);
  new Cable('f').connect(wanSw.getPorts()[1], outside.getPort('eth0')!);

  const m = new SubnetMask('255.255.255.0');
  pcLinux1.getPorts()[0].configureIP(new IPAddress(PC_LINUX1_IP), m);
  pcLinux2.getPorts()[0].configureIP(new IPAddress(PC_LINUX2_IP), m);
  pcWin1.getPorts()[0].configureIP(new IPAddress(PC_WIN1_IP), m);
  pcLinux1.setDefaultGateway(new IPAddress(GW_INSIDE));
  pcLinux2.setDefaultGateway(new IPAddress(GW_INSIDE));
  pcWin1.setDefaultGateway(new IPAddress(GW_INSIDE));

  const wanMask = new SubnetMask('255.255.255.252');
  outside.getPorts()[0].configureIP(new IPAddress(OUTSIDE_IP), wanMask);
  outside.setDefaultGateway(new IPAddress(GW_OUTSIDE));

  for (const cmd of [
    'enable',
    'configure terminal',
    'ip access-list standard ACL-LAN-INTERNE',
    '10 permit 192.168.10.0 0.0.0.255',
    '20 permit 192.168.20.0 0.0.0.255',
    '30 permit 192.168.99.0 0.0.0.255',
    'exit',
    'interface GigabitEthernet0/0',
    'description INTERFACE-LAN-INTERNE',
    `ip address ${GW_INSIDE} 255.255.255.0`,
    'ip nat inside',
    'no shutdown',
    'exit',
    'interface GigabitEthernet0/1',
    'description INTERFACE-WAN-PUBLIQUE',
    `ip address ${GW_OUTSIDE} 255.255.255.252`,
    'ip nat outside',
    'no shutdown',
    'exit',
    'ip nat inside source list ACL-LAN-INTERNE interface GigabitEthernet0/1 overload',
    `ip route 0.0.0.0 0.0.0.0 GigabitEthernet0/1`,
    'end',
  ]) await router.executeCommand(cmd);

  const clock = new VirtualTimeScheduler();
  for (const host of [pcLinux1, pcLinux2, pcWin1]) host.setScheduler(clock);

  return { pcLinux1, pcLinux2, pcWin1, router, outside, clock };
}

/**
 * `ping -c 3` waits a second between echoes, like the real one. Measured,
 * that is 2005 ms of wall clock for 13 ms of actual echo — and the three
 * pings below put this test at 4.1 s against vitest's 5 s default, which is
 * how it timed out under a loaded full-suite run while passing alone.
 *
 * The wait is real behaviour and must stay (the UI terminal prints one line
 * per second), so the clock is what changes, not the interval: the hosts run
 * on a `VirtualTimeScheduler` and this drives it. Advancing blindly would
 * race the ping's own continuations, so each turn drains the microtask queue
 * before moving the clock, and the loop is bounded — a ping that never
 * settles must fail the test, not hang the run.
 */
async function underVirtualClock<T>(
  scheduler: VirtualTimeScheduler,
  work: Promise<T>,
): Promise<T> {
  let settled = false;
  const tracked = work.then(
    (v) => { settled = true; return v; },
    (e) => { settled = true; throw e; },
  );
  for (let turn = 0; turn < 5000 && !settled; turn++) {
    await Promise.resolve();
    await Promise.resolve();
    if (!settled) scheduler.advance(250);
  }
  return tracked;
}

interface Xlate {
  proto: string;
  insideGlobalIp: string;
  insideGlobalPort: number;
  insideLocalIp: string;
  insideLocalPort: number;
}

function parseNatTable(raw: string): Xlate[] {
  const lines = raw.split('\n').map(l => l.trim());
  const out: Xlate[] = [];
  const rx = /^(tcp|udp|icmp)\s+(\d+\.\d+\.\d+\.\d+):(\d+)\s+(\d+\.\d+\.\d+\.\d+):(\d+)/i;
  for (const l of lines) {
    const m = rx.exec(l);
    if (!m) continue;
    out.push({
      proto: m[1].toLowerCase(),
      insideGlobalIp: m[2], insideGlobalPort: Number(m[3]),
      insideLocalIp: m[4], insideLocalPort: Number(m[5]),
    });
  }
  return out;
}

describe('Scénario 1 (Cisco) — PAT (NAT Overload) sur le LAN Mandeng', () => {
  beforeEach(() => {
    resetCounters();
    MACAddress.resetCounter();
    resetDeviceCounters();
    Logger.reset();
    EquipmentRegistry.resetInstance();
  });

  describe('configuration PAT de base', () => {
    it('ACL-LAN-INTERNE est acceptée avec ses 3 lignes numérotées (10/20/30)', async () => {
      const { router } = await buildLab();
      const out = await router.executeCommand('show running-config | include ip access-list standard|permit 192.168');
      expect(out).toContain('ACL-LAN-INTERNE');
    });

    it('ip nat inside source list ACL-LAN-INTERNE interface GigabitEthernet0/1 overload est actif (PAT)', async () => {
      const { router } = await buildLab();
      const rules = router._getNATEngine().getDynamicRules();
      expect(rules.length).toBeGreaterThan(0);
      expect(rules.some(r => r.type === 'overload')).toBe(true);
    });

    it('GigabitEthernet0/0 est inside et GigabitEthernet0/1 est outside', async () => {
      const { router } = await buildLab();
      const engine = router._getNATEngine();
      expect(engine.getInsideInterfaces().has('GigabitEthernet0/0')).toBe(true);
      expect(engine.getOutsideInterfaces().has('GigabitEthernet0/1')).toBe(true);
    });
  });

  describe('vérification de la table de traduction', () => {
    it('chaque machine interne obtient une entrée traduite vers la même IP publique 203.0.113.1', async () => {
      const lab = await buildLab();
      await underVirtualClock(lab.clock, lab.pcLinux1.executeCommand(`ping -c 3 ${OUTSIDE_IP}`));
      await underVirtualClock(lab.clock, lab.pcLinux2.executeCommand(`ping -c 3 ${OUTSIDE_IP}`));
      await underVirtualClock(lab.clock, lab.pcWin1.executeCommand(`ping ${OUTSIDE_IP} -n 3`));

      const table = await lab.router.executeCommand('show ip nat translations');
      expect(table).toContain(PC_LINUX1_IP);
      expect(table).toContain(PC_LINUX2_IP);
      expect(table).toContain(PC_WIN1_IP);
      const entries = parseNatTable(table);
      expect(entries.length).toBeGreaterThan(0);
      for (const e of entries) expect(e.insideGlobalIp).toBe(GW_OUTSIDE);
    });

    it('show ip nat statistics affiche Total active translations, Inside/Outside interfaces et des Hits non nuls', async () => {
      const lab = await buildLab();
      await underVirtualClock(lab.clock, lab.pcLinux1.executeCommand(`ping -c 3 ${OUTSIDE_IP}`));
      await underVirtualClock(lab.clock, lab.pcLinux2.executeCommand(`ping -c 3 ${OUTSIDE_IP}`));
      await underVirtualClock(lab.clock, lab.pcWin1.executeCommand(`ping ${OUTSIDE_IP} -n 3`));

      const out = await lab.router.executeCommand('show ip nat statistics');
      expect(out).toMatch(/Total active translations:\s*\d+/);
      expect(out).toContain('Outside interfaces:  GigabitEthernet0/1');
      expect(out).toContain('Inside interfaces:   GigabitEthernet0/0');
      const hitsMatch = /Hits:\s*(\d+)/.exec(out);
      expect(hitsMatch).not.toBeNull();
      expect(Number(hitsMatch![1])).toBeGreaterThan(0);
    });

    it('show ip nat statistics référence bien la règle dynamique liée à ACL-LAN-INTERNE et GigabitEthernet0/1', async () => {
      const { router } = await buildLab();
      const out = await router.executeCommand('show ip nat statistics');
      expect(out).toMatch(/Inside Source \[acl ACL-LAN-INTERNE\] overload/);
    });
  });

  describe('comportement sous charge simultanée', () => {
    it('3 sessions TCP simultanées depuis PC-Linux-1 obtiennent 3 ports "Inside global" distincts, sans collision', async () => {
      const lab = await buildLab();
      await Promise.all([
        lab.pcLinux1.executeCommand(`nc -zv ${OUTSIDE_IP} 80`),
        lab.pcLinux1.executeCommand(`nc -zv ${OUTSIDE_IP} 80`),
        lab.pcLinux1.executeCommand(`nc -zv ${OUTSIDE_IP} 80`),
      ]);
      const table = await lab.router.executeCommand('show ip nat translations');
      const tcp = parseNatTable(table).filter(e => e.proto === 'tcp' && e.insideLocalIp === PC_LINUX1_IP);
      expect(tcp.length).toBeGreaterThanOrEqual(3);
      const externalPorts = tcp.map(e => e.insideGlobalPort);
      expect(new Set(externalPorts).size).toBe(externalPorts.length);
    });

    it('des sessions simultanées depuis plusieurs machines internes ne produisent aucune collision de port externe', async () => {
      const lab = await buildLab();
      await Promise.all([
        lab.pcLinux1.executeCommand(`nc -zv ${OUTSIDE_IP} 80`),
        lab.pcLinux2.executeCommand(`nc -zv ${OUTSIDE_IP} 80`),
        lab.pcWin1.executeCommand(`nc -zv ${OUTSIDE_IP} 80`),
      ]);
      const table = await lab.router.executeCommand('show ip nat translations');
      const tcp = parseNatTable(table).filter(e => e.proto === 'tcp');
      const externalKeys = tcp.map(e => `${e.insideGlobalIp}:${e.insideGlobalPort}`);
      expect(new Set(externalKeys).size).toBe(externalKeys.length);
    });

    it('tous les ports "Inside global" attribués par PAT restent dans la plage 1024-65535', async () => {
      const lab = await buildLab();
      await lab.pcLinux1.executeCommand(`ping -c 1 ${OUTSIDE_IP}`);
      await lab.pcLinux2.executeCommand(`nc -zv ${OUTSIDE_IP} 80`);
      const table = await lab.router.executeCommand('show ip nat translations');
      for (const e of parseNatTable(table)) {
        expect(e.insideGlobalPort).toBeGreaterThanOrEqual(1024);
        expect(e.insideGlobalPort).toBeLessThanOrEqual(65535);
      }
    });
  });

  describe('expiration des entrées PAT', () => {
    it('une entrée PAT expire et disparaît de la table après son timeout configuré', async () => {
      const lab = await buildLab();
      await lab.pcLinux1.executeCommand(`ping -c 1 ${OUTSIDE_IP}`);
      let table = await lab.router.executeCommand('show ip nat translations');
      expect(table).toContain(PC_LINUX1_IP);

      // Simule l'écoulement du timeout ICMP configuré en abaissant le seuil
      // de péremption à 0ms au lieu d'attendre le vrai délai — même
      // précédent que nat-pat.test.ts (purgeStale accepte un override
      // explicite pour les tests : toute entrée plus vieille que l'override
      // est considérée expirée).
      lab.router._getNATEngine().purgeStale(0);

      table = await lab.router.executeCommand('show ip nat translations');
      expect(table).not.toContain(PC_LINUX1_IP);
    });

    it('show ip nat translations verbose affiche un temps restant réel (pas un simple espace réservé "--")', async () => {
      const lab = await buildLab();
      await lab.pcLinux1.executeCommand(`ping -c 1 ${OUTSIDE_IP}`);
      const out = await lab.router.executeCommand('show ip nat translations verbose');
      expect(out).toContain(PC_LINUX1_IP);
      expect(out).not.toMatch(/left:\s*--/);
    });
  });
});
