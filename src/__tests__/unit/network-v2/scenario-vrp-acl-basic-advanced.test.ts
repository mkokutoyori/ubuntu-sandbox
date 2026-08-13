/**
 * Scénario 5 — ACL sur switch et routeur Huawei (purement Huawei).
 *
 * ACL basique (2000-2999, source IP uniquement) et avancée (3000-3999,
 * protocole/IP/ports), appliquées via `traffic-filter inbound/outbound`,
 * avec compteurs de correspondance visibles via `display acl` et remise à
 * zéro via `reset acl counter`.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { HuaweiSwitch } from '@/network/devices/HuaweiSwitch';
import { HuaweiRouter } from '@/network/devices/HuaweiRouter';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { Cable } from '@/network/hardware/Cable';
import { resetCounters, MACAddress } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import { pingOnSimulatedClock } from '../../support/fastPing';

beforeEach(() => {
  resetCounters();
  MACAddress.resetCounter();
  resetDeviceCounters();
  Logger.reset();
  EquipmentRegistry.resetInstance();
});

interface SwitchLab { sw1: HuaweiSwitch; pcA: LinuxPC; pcB: LinuxPC; pcC: LinuxPC }

function buildSwitchLab(): SwitchLab {
  const sw1 = new HuaweiSwitch('switch-huawei', 'SW1', 5);
  const pcA = new LinuxPC('linux-pc', 'PC-A', 0, 0);
  const pcB = new LinuxPC('linux-pc', 'PC-B', 0, 0);
  const pcC = new LinuxPC('linux-pc', 'PC-C', 0, 0);
  new Cable('c1').connect(pcA.getPort('eth0')!, sw1.getPort('GigabitEthernet0/0/1')!);
  new Cable('c2').connect(pcB.getPort('eth0')!, sw1.getPort('GigabitEthernet0/0/2')!);
  new Cable('c3').connect(pcC.getPort('eth0')!, sw1.getPort('GigabitEthernet0/0/3')!);
  return { sw1, pcA, pcB, pcC };
}

async function configureSwitchPcs(pcA: LinuxPC, pcB: LinuxPC, pcC: LinuxPC): Promise<void> {
  await pcA.executeCommand('ifconfig eth0 192.168.1.10 netmask 255.255.255.0');
  await pcB.executeCommand('ifconfig eth0 192.168.1.20 netmask 255.255.255.0');
  await pcC.executeCommand('ifconfig eth0 192.168.1.30 netmask 255.255.255.0');
}

interface RouterLab { ar1: HuaweiRouter; pc1: LinuxPC; srv: LinuxPC }

function buildRouterLab(): RouterLab {
  const ar1 = new HuaweiRouter('AR1');
  const pc1 = new LinuxPC('linux-pc', 'PC1', 0, 0);
  const srv = new LinuxPC('linux-pc', 'SRV', 0, 0);
  new Cable('c1').connect(pc1.getPort('eth0')!, ar1.getPort('GE0/0/0')!);
  new Cable('c2').connect(srv.getPort('eth0')!, ar1.getPort('GE0/0/1')!);
  return { ar1, pc1, srv };
}

async function configureRouterLab(ar1: HuaweiRouter, pc1: LinuxPC, srv: LinuxPC): Promise<void> {
  await ar1.executeCommand('system-view');
  await ar1.executeCommand('interface GigabitEthernet 0/0/0');
  await ar1.executeCommand('ip address 192.168.10.254 24');
  await ar1.executeCommand('undo shutdown');
  await ar1.executeCommand('quit');
  await ar1.executeCommand('interface GigabitEthernet 0/0/1');
  await ar1.executeCommand('ip address 192.168.20.254 24');
  await ar1.executeCommand('undo shutdown');
  await ar1.executeCommand('quit');
  await ar1.executeCommand('return');

  await pc1.executeCommand('ifconfig eth0 192.168.10.101 netmask 255.255.255.0');
  await pc1.executeCommand('ip route add default via 192.168.10.254');
  await srv.executeCommand('ifconfig eth0 192.168.20.101 netmask 255.255.255.0');
  await srv.executeCommand('ip route add default via 192.168.20.254');
}

describe('Scénario 5 — ACL sur switch et routeur Huawei', () => {
  describe('ACL basique (2000-2999) sur switch — traffic-filter inbound', () => {
    it('deny source bloque le trafic du PC concerné dès son port d\'entrée', async () => {
      const { sw1, pcA, pcB, pcC } = buildSwitchLab();
      await configureSwitchPcs(pcA, pcB, pcC);

      await sw1.executeCommand('system-view');
      await sw1.executeCommand('acl number 2000');
      await sw1.executeCommand('rule 5 deny source 192.168.1.10 0');
      await sw1.executeCommand('rule 10 permit source any');
      await sw1.executeCommand('quit');
      await sw1.executeCommand('interface GigabitEthernet 0/0/1');
      await sw1.executeCommand('traffic-filter inbound acl 2000');
      await sw1.executeCommand('quit');
      await sw1.executeCommand('return');

      const pingBlocked = await pingOnSimulatedClock(pcA, 'ping -c 2 -W 1 192.168.1.20');
      expect(pingBlocked).toContain('100% packet loss');

      const pingAllowed = await pingOnSimulatedClock(pcC, 'ping -c 2 192.168.1.20');
      expect(pingAllowed).toContain('2 packets transmitted, 2 received');
    });
  });

  describe('traffic-filter outbound sur switch', () => {
    it('deny destination bloque le trafic entrant vers le PC concerné à sa sortie', async () => {
      const { sw1, pcA, pcB, pcC } = buildSwitchLab();
      await configureSwitchPcs(pcA, pcB, pcC);

      await sw1.executeCommand('system-view');
      await sw1.executeCommand('acl number 3000');
      await sw1.executeCommand('rule 5 deny ip destination 192.168.1.20 0');
      await sw1.executeCommand('rule 10 permit ip source any destination any');
      await sw1.executeCommand('quit');
      await sw1.executeCommand('interface GigabitEthernet 0/0/2');
      await sw1.executeCommand('traffic-filter outbound acl 3000');
      await sw1.executeCommand('quit');
      await sw1.executeCommand('return');

      // Both A→B and C→B are dropped on egress toward B, regardless of
      // which port they ingressed on.
      const fromA = await pingOnSimulatedClock(pcA, 'ping -c 1 -W 1 192.168.1.20');
      expect(fromA).toContain('100% packet loss');
      const fromC = await pingOnSimulatedClock(pcC, 'ping -c 1 -W 1 192.168.1.20');
      expect(fromC).toContain('100% packet loss');

      // A→C is untouched (no ACL on that egress port).
      const aToC = await pingOnSimulatedClock(pcA, 'ping -c 1 192.168.1.30');
      expect(aToC).toContain('1 packets transmitted, 1 received');
    }, 15000);
  });

  describe('ACL avancée (3000-3999) sur routeur — filtrage par protocole et port', () => {
    it('deny tcp destination-port eq 22 bloque uniquement ce port, pas ICMP', async () => {
      const { ar1, pc1, srv } = buildRouterLab();
      await configureRouterLab(ar1, pc1, srv);
      await srv.executeCommand('nc -l -p 22 &');

      await ar1.executeCommand('system-view');
      await ar1.executeCommand('acl number 3001');
      await ar1.executeCommand('rule 5 deny tcp source any destination any destination-port eq 22');
      await ar1.executeCommand('rule 10 permit ip source any destination any');
      await ar1.executeCommand('quit');
      await ar1.executeCommand('interface GigabitEthernet 0/0/0');
      await ar1.executeCommand('traffic-filter inbound acl 3001');
      await ar1.executeCommand('quit');
      await ar1.executeCommand('return');

      const probe = await pc1.executeCommand('nc -zv -w 1 192.168.20.101 22');
      expect(probe).toMatch(/timed out|refused/i);
      expect(probe).not.toMatch(/succeeded/i);

      const ping = await pingOnSimulatedClock(pc1, 'ping -c 2 192.168.20.101');
      expect(ping).toContain('2 packets transmitted, 2 received');
    });
  });

  describe('display acl avec compteurs et reset acl counter', () => {
    it('les compteurs de correspondance augmentent après trafic et reset acl counter les remet à zéro', async () => {
      const { ar1, pc1, srv } = buildRouterLab();
      await configureRouterLab(ar1, pc1, srv);
      await srv.executeCommand('nc -l -p 22 &');

      await ar1.executeCommand('system-view');
      await ar1.executeCommand('acl number 3002');
      await ar1.executeCommand('rule 5 deny tcp source any destination any destination-port eq 22');
      await ar1.executeCommand('rule 10 permit ip source any destination any');
      await ar1.executeCommand('quit');
      await ar1.executeCommand('interface GigabitEthernet 0/0/0');
      await ar1.executeCommand('traffic-filter inbound acl 3002');
      await ar1.executeCommand('quit');
      await ar1.executeCommand('return');

      await pc1.executeCommand('nc -zv -w 1 192.168.20.101 22');
      await pingOnSimulatedClock(pc1, 'ping -c 2 192.168.20.101');

      const before = await ar1.executeCommand('display acl 3002');
      expect(before).toMatch(/destination-port eq 22/);
      const denyLine = before.split('\n').find((l) => l.includes('destination-port eq 22'));
      expect(denyLine).toMatch(/\([1-9]\d* matche?s?\)/);
      // Both the deny (blocked nc probe) and the catch-all permit (the
      // ping) rules should have recorded at least one match each.
      const matchAnnotations = [...before.matchAll(/\((\d+) matches?\)/g)];
      expect(matchAnnotations.length).toBe(2);
      expect(matchAnnotations.every(([, n]) => Number(n) > 0)).toBe(true);

      await ar1.executeCommand('reset acl counter 3002');
      const after = await ar1.executeCommand('display acl 3002');
      expect(after).not.toMatch(/\(\d+ matches?\)/);
    });
  });

  describe('critère de réussite', () => {
    it('ACL basique bloque par source, ACL avancée filtre par port sans affecter ICMP, compteurs cohérents', async () => {
      const swLab = buildSwitchLab();
      await configureSwitchPcs(swLab.pcA, swLab.pcB, swLab.pcC);
      await swLab.sw1.executeCommand('system-view');
      await swLab.sw1.executeCommand('acl number 2001');
      await swLab.sw1.executeCommand('rule deny source 192.168.1.10 0');
      await swLab.sw1.executeCommand('rule permit source any');
      await swLab.sw1.executeCommand('quit');
      await swLab.sw1.executeCommand('interface GigabitEthernet 0/0/1');
      await swLab.sw1.executeCommand('traffic-filter inbound acl 2001');
      await swLab.sw1.executeCommand('quit');
      await swLab.sw1.executeCommand('return');
      const basicBlocked = await pingOnSimulatedClock(swLab.pcA, 'ping -c 1 -W 1 192.168.1.20');
      expect(basicBlocked).toContain('100% packet loss');

      const { ar1, pc1, srv } = buildRouterLab();
      await configureRouterLab(ar1, pc1, srv);
      await srv.executeCommand('nc -l -p 22 &');
      await ar1.executeCommand('system-view');
      await ar1.executeCommand('acl number 3003');
      await ar1.executeCommand('rule deny tcp source any destination any destination-port eq 22');
      await ar1.executeCommand('rule permit ip source any destination any');
      await ar1.executeCommand('quit');
      await ar1.executeCommand('interface GigabitEthernet 0/0/0');
      await ar1.executeCommand('traffic-filter inbound acl 3003');
      await ar1.executeCommand('quit');
      await ar1.executeCommand('return');

      const advBlocked = await pc1.executeCommand('nc -zv -w 1 192.168.20.101 22');
      expect(advBlocked).not.toMatch(/succeeded/i);
      const icmpStillWorks = await pingOnSimulatedClock(pc1, 'ping -c 1 192.168.20.101');
      expect(icmpStillWorks).toContain('1 packets transmitted, 1 received');

      const display = await ar1.executeCommand('display acl 3003');
      expect(display).toMatch(/\([1-9]\d* matche?s?\)/);
    });
  });
});
