import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { resetCounters } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  Logger.reset();
});

describe('-j MARK sets a readable, non-terminal mark', () => {
  it('accepts -j MARK --set-mark as a valid target and shows it in -S output', async () => {
    const srv = new LinuxServer('linux-server', 'SRV5');
    srv.powerOn();
    await srv.executeCommand('iptables -t mangle -A PREROUTING -j MARK --set-mark 0x1');
    const out = await srv.executeCommand('iptables -t mangle -S PREROUTING');
    expect(out).toContain('-j MARK --set-mark 0x1');
  });

  it('MARK does not terminate chain evaluation — a later rule still decides the verdict', async () => {
    const srv = new LinuxServer('linux-server', 'SRV6');
    srv.powerOn();
    await srv.executeCommand('iptables -A INPUT -p tcp --dport 80 -j MARK --set-mark 0x7');
    await srv.executeCommand('iptables -A INPUT -p tcp --dport 80 -j DROP');

    const ipt = (srv as unknown as { executor: { iptables: { filterPacket: (p: unknown) => string; getLastMark: () => string | null } } }).executor.iptables;
    const verdict = ipt.filterPacket({ direction: 'in', protocol: 6, srcIP: '10.0.0.1', dstIP: '10.0.0.2', srcPort: 1234, dstPort: 80, iface: 'eth0' });
    expect(verdict).toBe('drop');
    expect(ipt.getLastMark()).toBe('0x7');
  });

  it('getLastMark() is null when no MARK rule matched', async () => {
    const srv = new LinuxServer('linux-server', 'SRV7');
    srv.powerOn();
    await srv.executeCommand('iptables -A INPUT -p tcp --dport 80 -j ACCEPT');

    const ipt = (srv as unknown as { executor: { iptables: { filterPacket: (p: unknown) => string; getLastMark: () => string | null } } }).executor.iptables;
    ipt.filterPacket({ direction: 'in', protocol: 6, srcIP: '10.0.0.1', dstIP: '10.0.0.2', srcPort: 1234, dstPort: 80, iface: 'eth0' });
    expect(ipt.getLastMark()).toBeNull();
  });
});

describe('-j NOTRACK is a valid, non-terminal target', () => {
  it('accepts -j NOTRACK in the raw table', async () => {
    const srv = new LinuxServer('linux-server', 'SRV8');
    srv.powerOn();
    await srv.executeCommand('iptables -t raw -A PREROUTING -p udp --dport 53 -j NOTRACK');
    const out = await srv.executeCommand('iptables -t raw -S PREROUTING');
    expect(out).toContain('-j NOTRACK');
  });

  it('NOTRACK does not terminate chain evaluation', async () => {
    const srv = new LinuxServer('linux-server', 'SRV9');
    srv.powerOn();
    await srv.executeCommand('iptables -A INPUT -p tcp --dport 80 -j NOTRACK');
    await srv.executeCommand('iptables -A INPUT -p tcp --dport 80 -j DROP');

    const ipt = (srv as unknown as { executor: { iptables: { filterPacket: (p: unknown) => string } } }).executor.iptables;
    const verdict = ipt.filterPacket({ direction: 'in', protocol: 6, srcIP: '10.0.0.1', dstIP: '10.0.0.2', srcPort: 1234, dstPort: 80, iface: 'eth0' });
    expect(verdict).toBe('drop');
  });
});
