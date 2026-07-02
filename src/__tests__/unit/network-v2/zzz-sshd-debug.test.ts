import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { IPAddress, SubnetMask, MACAddress, resetCounters } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
beforeEach(() => { resetCounters(); MACAddress.resetCounter(); resetDeviceCounters(); Logger.reset(); EquipmentRegistry.resetInstance(); });
describe('sshd listener on LinuxPC', () => {
  it('lists tcp listeners', () => {
    const pc = new LinuxPC('linux-pc', 'pc', 0, 0);
    pc.getPorts()[0].configureIP(new IPAddress('10.0.0.2'), new SubnetMask('255.255.255.0'));
    const st = pc.getSocketTable().getAll().filter(s => s.protocol === 'tcp');
    console.log('TCP SOCKETS:', JSON.stringify(st));
    const stack = (pc as unknown as { tcpv2: { listListeners():{localPort:number}[] } }).tcpv2;
    console.log('LISTENERS:', JSON.stringify(stack.listListeners().map(l=>l.localPort)));
    expect(true).toBe(true);
  });
});
