import { describe, it, expect } from 'vitest';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { WindowsPC } from '@/network/devices/WindowsPC';
import { HuaweiSwitch } from '@/network/devices/HuaweiSwitch';
import { CiscoSwitch } from '@/network/devices/CiscoSwitch';
import { Cable } from '@/network/hardware/Cable';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';

async function setupTopo(sw: any) {
  const pc4 = new LinuxPC('linux-pc', 'PC4', 0, 0);
  const pc5 = new LinuxPC('linux-pc', 'PC5', 0, 0);
  const winPc = new WindowsPC('windows-pc', 'PC3', 0, 0);
  [pc4, pc5, winPc, sw].forEach((d) => d.powerOn());
  const swPortArr = Array.from(sw.getPorts().values());
  new Cable('c1').connect(pc4.getPort('eth0')!, swPortArr[0]);
  new Cable('c2').connect(pc5.getPort('eth0')!, swPortArr[1]);
  new Cable('c3').connect(winPc.getPort('eth0')!, swPortArr[2]);
  await pc4.executeCommand('ifconfig eth0 192.168.2.1');
  await pc5.executeCommand('ifconfig eth0 192.168.2.2');
  await winPc.executeCommand('netsh interface ipv4 set address "Ethernet" static 192.168.2.3 255.255.255.0');
  return { pc4, pc5, winPc };
}

for (const [name, makeSwitch] of [
  ['Huawei', () => new HuaweiSwitch('switch-huawei', 'sw', 8, 0, 0)],
  ['Cisco', () => new CiscoSwitch('switch-cisco', 'sw', 8, 0, 0)],
] as const) {
  describe(`${name} switch: ARP survives past 60s gc_stale_time`, () => {
    it(`PC4 → PC5 → ping then arp; entry persists after simulated aging`, async () => {
      EquipmentRegistry.resetInstance();
      const sw = makeSwitch();
      const { pc4 } = await setupTopo(sw);
      await pc4.executeCommand('ping -c 1 -W 1 192.168.2.2');
      const table = pc4.getARPTableFull();
      table.get('192.168.2.2')!.timestamp = Date.now() - 120_000;
      (pc4 as any).ageArpEntries();
      const arp = await pc4.executeCommand('arp');
      expect(arp).toContain('192.168.2.2');
    });

    it(`Windows arp -a shows both Linux PCs after pings`, async () => {
      EquipmentRegistry.resetInstance();
      const sw = makeSwitch();
      const { pc4, pc5, winPc } = await setupTopo(sw);
      await winPc.executeCommand('ping 192.168.2.1');
      await winPc.executeCommand('ping 192.168.2.2');
      const arp = await winPc.executeCommand('arp -a');
      expect(arp).toContain('192.168.2.1');
      expect(arp).toContain('192.168.2.2');
    });
  });
}
