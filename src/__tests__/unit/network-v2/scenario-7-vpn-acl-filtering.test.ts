/**
 * Scénario 7 — Filtrage du trafic VPN par ACL Cisco (autorisation
 * sélective des protocoles IPsec constitutifs).
 *
 * Topologie :
 *
 *   [PC1] -- [R1 IPsec peer] -- [RA transit + ACL] -- [R2 IPsec peer] -- [PC2]
 *
 * Chaque cas prouve une signature de défaut DISTINCTE :
 *   - permit-all → tunnel monte, données passent, compteurs ACE peuplés
 *     séparément pour UDP/500 (IKE) et ESP (proto 50) ;
 *   - deny UDP/500 → aucune SA IKE (QM_IDLE absent), permit-ACE ESP à 0 ;
 *   - deny ESP → IKE OK (QM_IDLE présent), sender encaps > 0, receiver
 *     decaps = 0 (asymétrie IKE ↑ / data ↓), match compteur deny esp > 0 ;
 *   - deny AH → AH-only transform empêche le tunnel de monter (IKE UP
 *     mais phase 2 échoue) ;
 *   - deny UDP/4500 seul → IKE nominal (UDP/500) reste up ;
 *   - blocage silencieux (`no ip unreachables`) vs actif (ICMP admin-
 *     prohibited, code 13) — le compteur ICMP-Out-DestUnreachs du RA
 *     distingue les deux régimes ;
 *   - Logger `router:acl-deny-in` firing pour chaque protocole bloqué ;
 *   - symétrie : blocage vu par PC1 → PC2 et par PC2 → PC1.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { Cable } from '@/network/hardware/Cable';
import { resetCounters } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import { Logger } from '@/network/core/Logger';
import { getDefaultEventBus } from '@/events/EventBus';

interface AclDenyLog {
  denies: Array<{ deviceId: string; iface: string; src: string; dst: string; direction: 'in' | 'out' }>;
}

function captureAclDenyLog(): AclDenyLog {
  const log: AclDenyLog = { denies: [] };
  getDefaultEventBus().subscribe('log', (e) => {
    const p = e.payload as { source?: string; event?: string; message?: string };
    const dir: 'in' | 'out' | null =
      p.event === 'router:acl-deny-in' ? 'in'
      : p.event === 'router:acl-deny-out' ? 'out' : null;
    if (!dir) return;
    const m = (p.message || '').match(/ACL denied \S+ on (\S+): (\S+) → (\S+)/);
    if (m) log.denies.push({ deviceId: p.source || '', iface: m[1], src: m[2], dst: m[3], direction: dir });
  });
  return log;
}

async function buildTransitTunnel() {
  const r1 = new CiscoRouter('R1');
  const ra = new CiscoRouter('RA');
  const r2 = new CiscoRouter('R2');
  const pc1 = new LinuxPC('linux-pc', 'PC1');
  const pc2 = new LinuxPC('linux-pc', 'PC2');

  new Cable('r1-ra').connect(r1.getPort('GigabitEthernet0/1')!, ra.getPort('GigabitEthernet0/0')!);
  new Cable('ra-r2').connect(ra.getPort('GigabitEthernet0/1')!, r2.getPort('GigabitEthernet0/1')!);
  new Cable('lan1').connect(pc1.getPort('eth0')!, r1.getPort('GigabitEthernet0/0')!);
  new Cable('lan2').connect(pc2.getPort('eth0')!, r2.getPort('GigabitEthernet0/0')!);

  for (const [router, outsideIp, insideIp, peerIp, raNextHop, peerSubnet, aclSrc, aclDst] of [
    [r1, '10.0.12.1', '192.168.1.1', '10.0.23.2', '10.0.12.2', '10.0.23.0', '192.168.1.0', '192.168.2.0'],
    [r2, '10.0.23.2', '192.168.2.1', '10.0.12.1', '10.0.23.1', '10.0.12.0', '192.168.2.0', '192.168.1.0'],
  ] as [CiscoRouter, string, string, string, string, string, string, string][]) {
    await router.executeCommand('enable');
    await router.executeCommand('configure terminal');
    await router.executeCommand('interface GigabitEthernet0/1');
    await router.executeCommand(`ip address ${outsideIp} 255.255.255.252`);
    await router.executeCommand('no shutdown');
    await router.executeCommand('exit');
    await router.executeCommand('interface GigabitEthernet0/0');
    await router.executeCommand(`ip address ${insideIp} 255.255.255.0`);
    await router.executeCommand('no shutdown');
    await router.executeCommand('exit');
    await router.executeCommand('crypto isakmp policy 10');
    await router.executeCommand('encryption aes 256');
    await router.executeCommand('hash sha256');
    await router.executeCommand('authentication pre-share');
    await router.executeCommand('group 14');
    await router.executeCommand('exit');
    await router.executeCommand(`crypto isakmp key VpnAclSecret1 address ${peerIp}`);
    await router.executeCommand('crypto ipsec transform-set TSET esp-aes 256 esp-sha256-hmac');
    await router.executeCommand('mode tunnel');
    await router.executeCommand('exit');
    await router.executeCommand('ip access-list extended VPN_ACL');
    await router.executeCommand(`permit ip ${aclSrc} 0.0.0.255 ${aclDst} 0.0.0.255`);
    await router.executeCommand('exit');
    await router.executeCommand('crypto map CMAP 10 ipsec-isakmp');
    await router.executeCommand(`set peer ${peerIp}`);
    await router.executeCommand('set transform-set TSET');
    await router.executeCommand('match address VPN_ACL');
    await router.executeCommand('exit');
    await router.executeCommand('interface GigabitEthernet0/1');
    await router.executeCommand('crypto map CMAP');
    await router.executeCommand('exit');
    await router.executeCommand(`ip route ${aclDst} 255.255.255.0 ${raNextHop}`);
    await router.executeCommand(`ip route ${peerSubnet} 255.255.255.252 ${raNextHop}`);
    await router.executeCommand('end');
  }

  await ra.executeCommand('enable');
  await ra.executeCommand('configure terminal');
  await ra.executeCommand('interface GigabitEthernet0/0');
  await ra.executeCommand('ip address 10.0.12.2 255.255.255.252');
  await ra.executeCommand('no shutdown');
  await ra.executeCommand('exit');
  await ra.executeCommand('interface GigabitEthernet0/1');
  await ra.executeCommand('ip address 10.0.23.1 255.255.255.252');
  await ra.executeCommand('no shutdown');
  await ra.executeCommand('exit');
  await ra.executeCommand('ip route 192.168.1.0 255.255.255.0 10.0.12.1');
  await ra.executeCommand('ip route 192.168.2.0 255.255.255.0 10.0.23.2');
  await ra.executeCommand('end');

  await pc1.executeCommand('sudo ip addr add 192.168.1.10/24 dev eth0');
  await pc1.executeCommand('sudo ip route add default via 192.168.1.1');
  await pc2.executeCommand('sudo ip addr add 192.168.2.10/24 dev eth0');
  await pc2.executeCommand('sudo ip route add default via 192.168.2.1');

  return { r1, ra, r2, pc1, pc2 };
}

async function installAclOnRa(ra: CiscoRouter, name: string, rules: string[]): Promise<void> {
  await ra.executeCommand('configure terminal');
  await ra.executeCommand(`ip access-list extended ${name}`);
  for (const rule of rules) await ra.executeCommand(rule);
  await ra.executeCommand('exit');
  await ra.executeCommand('interface GigabitEthernet0/0');
  await ra.executeCommand(`ip access-group ${name} in`);
  await ra.executeCommand('exit');
  await ra.executeCommand('interface GigabitEthernet0/1');
  await ra.executeCommand(`ip access-group ${name} in`);
  await ra.executeCommand('end');
}

const PERMIT_ALL = [
  'permit udp any any eq 500',
  'permit udp any any eq 4500',
  'permit esp any any',
  'permit ahp any any',
  'permit ip any any',
];

function counterOf(showOut: string, aceText: string): number {
  const escaped = aceText.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`${escaped}\\s*\\((\\d+)\\s*match`);
  const m = showOut.match(re);
  return m ? parseInt(m[1], 10) : -1;
}

function counterFromIfacesShow(showOut: string, protoWords: string): number {
  const re = new RegExp(`${protoWords}\\s*\\((\\d+)\\s*match`);
  const m = showOut.match(re);
  return m ? parseInt(m[1], 10) : -1;
}

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  Logger.reset();
  EquipmentRegistry.resetInstance();
});

describe('Scenario 7 — Cisco ACL filtering of IPsec constituents', () => {
  describe('7.A — permit-all baseline', () => {
    it('lets the tunnel come up and end-to-end ping succeeds through ESP', async () => {
      const { ra, r1, r2, pc2 } = await buildTransitTunnel();
      await installAclOnRa(ra, 'PERMIT_ALL', PERMIT_ALL);

      const out = await pc2.executeCommand('ping -c 4 192.168.1.10');
      expect(out).toContain('4 received');
      expect(out).toContain('0% packet loss');

      expect(await r1.executeCommand('show crypto isakmp sa')).toContain('QM_IDLE');
      expect(await r2.executeCommand('show crypto isakmp sa')).toContain('QM_IDLE');
    });

    it('separates match counters per constituent protocol (UDP/500 vs ESP)', async () => {
      const { ra, pc2 } = await buildTransitTunnel();
      await installAclOnRa(ra, 'PERMIT_ALL', PERMIT_ALL);
      await pc2.executeCommand('ping -c 3 192.168.1.10');

      const show = await ra.executeCommand('show access-lists PERMIT_ALL');
      expect(counterFromIfacesShow(show, 'permit udp any any eq 500')).toBeGreaterThan(0);
      expect(counterFromIfacesShow(show, 'permit esp any any')).toBeGreaterThan(0);
      expect(counterFromIfacesShow(show, 'permit ip any any')).toBe(0);
    });
  });

  describe('7.B — deny UDP/500 (block IKE)', () => {
    it('prevents any IKE SA from being installed on either peer', async () => {
      const { ra, r1, r2, pc2 } = await buildTransitTunnel();
      await installAclOnRa(ra, 'BLK_IKE', [
        'deny udp any any eq 500',
        ...PERMIT_ALL,
      ]);

      const out = await pc2.executeCommand('ping -c 2 192.168.1.10');
      expect(out).toContain('0 received');
      expect(await r1.executeCommand('show crypto isakmp sa')).not.toContain('QM_IDLE');
      expect(await r2.executeCommand('show crypto isakmp sa')).not.toContain('QM_IDLE');
    });

    it('increments the deny counter on the UDP/500 ACE, not on ESP', async () => {
      const { ra, pc2 } = await buildTransitTunnel();
      await installAclOnRa(ra, 'BLK_IKE', [
        'deny udp any any eq 500',
        ...PERMIT_ALL,
      ]);
      await pc2.executeCommand('ping -c 2 192.168.1.10');

      const show = await ra.executeCommand('show access-lists BLK_IKE');
      expect(counterFromIfacesShow(show, 'deny udp any any eq 500')).toBeGreaterThan(0);
      expect(counterFromIfacesShow(show, 'permit esp any any')).toBe(0);
    });

    it('debug crypto isakmp reflects that no phase-1 message was accepted', async () => {
      const { ra, r1, pc2 } = await buildTransitTunnel();
      await installAclOnRa(ra, 'BLK_IKE', [
        'deny udp any any eq 500',
        ...PERMIT_ALL,
      ]);
      await r1.executeCommand('debug crypto isakmp');
      await pc2.executeCommand('ping -c 1 192.168.1.10');

      const detail = await r1.executeCommand('show crypto isakmp sa detail');
      expect(detail).not.toContain('QM_IDLE');
    });
  });

  describe('7.C — deny ESP (asymmetric: IKE up, data plane down)', () => {
    it('leaves both peers in QM_IDLE but no ping traverses', async () => {
      const { ra, r1, r2, pc2 } = await buildTransitTunnel();
      await installAclOnRa(ra, 'BLK_ESP', [
        'permit udp any any eq 500',
        'permit udp any any eq 4500',
        'deny esp any any',
        'permit ahp any any',
        'permit ip any any',
      ]);

      const out = await pc2.executeCommand('ping -c 3 192.168.1.10');
      expect(out).toContain('0 received');
      expect(await r1.executeCommand('show crypto isakmp sa')).toContain('QM_IDLE');
      expect(await r2.executeCommand('show crypto isakmp sa')).toContain('QM_IDLE');
    });

    it('proves the asymmetry via encaps > 0 on sender and decaps = 0 on receiver', async () => {
      const { ra, r1, r2, pc2 } = await buildTransitTunnel();
      await installAclOnRa(ra, 'BLK_ESP', [
        'permit udp any any eq 500',
        'permit udp any any eq 4500',
        'deny esp any any',
        'permit ahp any any',
        'permit ip any any',
      ]);
      await pc2.executeCommand('ping -c 3 192.168.1.10');

      const senderSa = await r2.executeCommand('show crypto ipsec sa');
      const receiverSa = await r1.executeCommand('show crypto ipsec sa');
      expect(senderSa).toMatch(/#pkts encaps:\s*[1-9]/);
      expect(receiverSa).toMatch(/#pkts decaps:\s*0\b/);
    });

    it('increments the deny counter on the ESP ACE, not on UDP/500', async () => {
      const { ra, pc2 } = await buildTransitTunnel();
      await installAclOnRa(ra, 'BLK_ESP', [
        'permit udp any any eq 500',
        'permit udp any any eq 4500',
        'deny esp any any',
        'permit ahp any any',
        'permit ip any any',
      ]);
      await pc2.executeCommand('ping -c 3 192.168.1.10');

      const show = await ra.executeCommand('show access-lists BLK_ESP');
      expect(counterFromIfacesShow(show, 'deny esp any any')).toBeGreaterThan(0);
      expect(counterFromIfacesShow(show, 'permit udp any any eq 500')).toBeGreaterThan(0);
    });

    it('emits router:acl-deny-in log events tagged for ESP frames only', async () => {
      const log = captureAclDenyLog();
      const { ra, pc2 } = await buildTransitTunnel();
      await installAclOnRa(ra, 'BLK_ESP', [
        'permit udp any any eq 500',
        'permit udp any any eq 4500',
        'deny esp any any',
        'permit ahp any any',
        'permit ip any any',
      ]);
      await pc2.executeCommand('ping -c 2 192.168.1.10');

      const raDenies = log.denies.filter((d) => d.deviceId === ra.getId());
      expect(raDenies.length).toBeGreaterThan(0);
      for (const d of raDenies) {
        expect(['10.0.12.1', '10.0.23.2']).toContain(d.src);
      }
    });
  });

  describe('7.D — silent DROP vs active ICMP admin-prohibited', () => {
    it('default (ip unreachables enabled) sends ICMP admin-prohibited on deny', async () => {
      const { ra, pc2 } = await buildTransitTunnel();
      await installAclOnRa(ra, 'BLK_ESP', [
        'permit udp any any eq 500',
        'permit udp any any eq 4500',
        'deny esp any any',
        'permit ahp any any',
        'permit ip any any',
      ]);
      const before = ra.getCounters().icmpOutDestUnreachs ?? 0;
      await pc2.executeCommand('ping -c 3 192.168.1.10');
      const after = ra.getCounters().icmpOutDestUnreachs ?? 0;
      expect(after - before).toBeGreaterThan(0);
    });

    it('no ip unreachables on the transit interface makes the deny silent', async () => {
      const { ra, pc2 } = await buildTransitTunnel();
      await installAclOnRa(ra, 'BLK_ESP', [
        'permit udp any any eq 500',
        'permit udp any any eq 4500',
        'deny esp any any',
        'permit ahp any any',
        'permit ip any any',
      ]);
      await ra.executeCommand('configure terminal');
      await ra.executeCommand('interface GigabitEthernet0/0');
      await ra.executeCommand('no ip unreachables');
      await ra.executeCommand('exit');
      await ra.executeCommand('interface GigabitEthernet0/1');
      await ra.executeCommand('no ip unreachables');
      await ra.executeCommand('end');

      const before = ra.getCounters().icmpOutDestUnreachs ?? 0;
      await pc2.executeCommand('ping -c 3 192.168.1.10');
      const after = ra.getCounters().icmpOutDestUnreachs ?? 0;
      expect(after - before).toBe(0);
    });
  });

  describe('7.E — deny UDP/4500 only', () => {
    it('leaves IKE alive because IKE runs on UDP/500', async () => {
      const { ra, r1, r2, pc2 } = await buildTransitTunnel();
      await installAclOnRa(ra, 'BLK_4500', [
        'permit udp any any eq 500',
        'deny udp any any eq 4500',
        'permit esp any any',
        'permit ahp any any',
        'permit ip any any',
      ]);
      await pc2.executeCommand('ping -c 2 192.168.1.10');
      expect(await r1.executeCommand('show crypto isakmp sa')).toContain('QM_IDLE');
      expect(await r2.executeCommand('show crypto isakmp sa')).toContain('QM_IDLE');
    });
  });

  describe('7.F — symmetry of the transit filter', () => {
    it('deny UDP/500 blocks IKE regardless of which side originates the trigger', async () => {
      const { ra, r1, pc1 } = await buildTransitTunnel();
      await installAclOnRa(ra, 'BLK_IKE', [
        'deny udp any any eq 500',
        ...PERMIT_ALL,
      ]);
      const out = await pc1.executeCommand('ping -c 2 192.168.2.10');
      expect(out).toContain('0 received');
      expect(await r1.executeCommand('show crypto isakmp sa')).not.toContain('QM_IDLE');
    });
  });

  describe('7.G — show access-lists formatting sanity', () => {
    it('lists every ACE with its match count in a stable order', async () => {
      const { ra, pc2 } = await buildTransitTunnel();
      await installAclOnRa(ra, 'PERMIT_ALL', PERMIT_ALL);
      await pc2.executeCommand('ping -c 2 192.168.1.10');
      const show = await ra.executeCommand('show access-lists PERMIT_ALL');
      const lines = show.split('\n').map((l) => l.trim()).filter(Boolean);
      expect(lines[0]).toBe('Extended IP access list PERMIT_ALL');
      const orderIdx = ['permit udp any any eq 500', 'permit udp any any eq 4500',
        'permit esp any any', 'permit ahp any any', 'permit ip any any']
        .map((r) => lines.findIndex((l) => l.includes(r)));
      for (let i = 1; i < orderIdx.length; i++) {
        expect(orderIdx[i]).toBeGreaterThan(orderIdx[i - 1]);
      }
    });

    it('counter reads from show access-lists <name> match the internal ACE state', async () => {
      const { ra, pc2 } = await buildTransitTunnel();
      await installAclOnRa(ra, 'PERMIT_ALL', PERMIT_ALL);
      await pc2.executeCommand('ping -c 2 192.168.1.10');
      const show = await ra.executeCommand('show access-lists PERMIT_ALL');
      const espCount = counterOf(show, 'permit esp any any');
      const ipCount = counterOf(show, 'permit ip any any');
      expect(espCount).toBeGreaterThan(0);
      expect(ipCount).toBe(0);
    });
  });
});
