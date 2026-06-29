import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { CiscoSwitch } from '@/network/devices/CiscoSwitch';
import { Cable } from '@/network/hardware/Cable';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';

describe('ARP / neighbor coherence across arp, ip neigh, /proc and /sys', () => {
  let pc: LinuxPC;
  let srv: LinuxServer;

  beforeEach(async () => {
    EquipmentRegistry.resetInstance();
    pc = new LinuxPC('linux-pc', 'pc1', 0, 0);
    srv = new LinuxServer('linux-server', 'srv1', 0, 0);
    const sw = new CiscoSwitch('switch-cisco', 'sw', 8, 0, 0);
    [pc, srv, sw].forEach((d) => d.powerOn());
    new Cable('c1').connect(pc.getPort('eth0')!, sw.getPort('FastEthernet0/1')!);
    new Cable('c2').connect(srv.getPort('eth0')!, sw.getPort('FastEthernet0/2')!);
    await pc.executeCommand('ifconfig eth0 10.0.0.1');
    await srv.executeCommand('ifconfig eth0 10.0.0.2');
    await pc.executeCommand('ping -c 1 10.0.0.2');
  });

  function macFromArp(line: string): string {
    const m = line.match(/([0-9a-fA-F:]{17})/);
    return m?.[1].toLowerCase() ?? '';
  }

  describe('/proc/net/arp exists and matches arp -n output', () => {
    it('/proc/net/arp has the kernel header and one row per neighbor', async () => {
      const out = await pc.executeCommand('cat /proc/net/arp');
      const lines = out.split('\n').filter(Boolean);
      expect(lines[0]).toMatch(/^IP address\s+HW type\s+Flags\s+HW address\s+Mask\s+Device$/);
      expect(lines.some((l) => /^10\.0\.0\.2\b/.test(l))).toBe(true);
    });

    it('/proc/net/arp MAC matches arp -n MAC for the same IP', async () => {
      const arpN = await pc.executeCommand('arp -n');
      const arpRow = arpN.split('\n').find((l) => /^10\.0\.0\.2\b/.test(l)) ?? '';
      const procRow = (await pc.executeCommand('cat /proc/net/arp'))
        .split('\n').find((l) => /^10\.0\.0\.2\b/.test(l)) ?? '';
      expect(macFromArp(arpRow)).toBe(macFromArp(procRow));
      expect(macFromArp(arpRow)).toMatch(/^[0-9a-f:]{17}$/);
    });

    it('/proc/net/arp flags reflect static (0x6) vs dynamic (0x2)', async () => {
      await pc.executeCommand('arp -s 10.0.0.99 aa:bb:cc:dd:ee:ff');
      const out = await pc.executeCommand('cat /proc/net/arp');
      const staticRow = out.split('\n').find((l) => /^10\.0\.0\.99\b/.test(l)) ?? '';
      const dynamicRow = out.split('\n').find((l) => /^10\.0\.0\.2\b/.test(l)) ?? '';
      expect(staticRow).toMatch(/0x6/);
      expect(dynamicRow).toMatch(/0x2/);
    });
  });

  describe('/sys/class/net/<iface>/address reads the live port MAC', () => {
    it('the MAC on srv /sys matches what pc arp -n shows for srv', async () => {
      const arpRow = (await pc.executeCommand('arp -n'))
        .split('\n').find((l) => /^10\.0\.0\.2\b/.test(l)) ?? '';
      const seenByPc = macFromArp(arpRow);
      const ownView = (await srv.executeCommand('cat /sys/class/net/eth0/address')).trim().toLowerCase();
      expect(ownView).toBe(seenByPc);
    });
  });

  describe('/sys/class/net/<iface>/arp toggle', () => {
    it('/sys/class/net/eth0/arp exists and reads 1 by default', async () => {
      const out = (await srv.executeCommand('cat /sys/class/net/eth0/arp')).trim();
      expect(out).toBe('1');
    });
  });

  describe('ARP sysctls under /proc/sys/net/ipv4', () => {
    it('default arp_announce / arp_ignore / arp_accept are readable', async () => {
      expect((await srv.executeCommand('cat /proc/sys/net/ipv4/conf/all/arp_announce')).trim()).toBe('0');
      expect((await srv.executeCommand('cat /proc/sys/net/ipv4/conf/all/arp_ignore')).trim()).toBe('0');
      expect((await srv.executeCommand('cat /proc/sys/net/ipv4/conf/all/arp_accept')).trim()).toBe('0');
    });

    it('per-interface arp_announce / arp_ignore are readable', async () => {
      expect((await srv.executeCommand('cat /proc/sys/net/ipv4/conf/eth0/arp_announce')).trim()).toBe('0');
      expect((await srv.executeCommand('cat /proc/sys/net/ipv4/conf/eth0/arp_ignore')).trim()).toBe('0');
    });

    it('neighbor-table tuning files are readable', async () => {
      expect((await srv.executeCommand('cat /proc/sys/net/ipv4/neigh/default/base_reachable_time_ms')).trim()).toMatch(/^\d+$/);
      expect((await srv.executeCommand('cat /proc/sys/net/ipv4/neigh/default/gc_thresh1')).trim()).toMatch(/^\d+$/);
    });
  });
});
