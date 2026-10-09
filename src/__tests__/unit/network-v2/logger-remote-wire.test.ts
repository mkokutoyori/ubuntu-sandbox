/*
 * logger -n SERVER delivers over the simulated network.  The datagram built by the util-linux 2.39.3 port leaves through
 * the host's UDP egress (ARP, switch, cable) and reaches the collector's rsyslog receiver, which files it by facility.
 * Measured before the port was wired (git stash push -u -- src/network): 3 of the 5 cases fall - the collector receives
 * nothing, the frame count does not move and the unresolvable-name refusal is not worded like the tool.  The two that pass
 * either way are WITNESSES: the local-socket delivery, and the closed receiver (a collector whose imudp is not enabled
 * files nothing, which proves the positive case above is the wire and not a shared object).
 * The frame measure is a DIFFERENCE: the same command with and without --no-act, so the ARP exchange that precedes the
 * first datagram counts on both sides and only the payload frames remain.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { GenericSwitch } from '@/network/devices/GenericSwitch';
import { Cable } from '@/network/hardware/Cable';
import { MACAddress, IPAddress, SubnetMask, resetCounters } from '@/network/core/types';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  MACAddress.resetCounter();
  EquipmentRegistry.resetInstance();
  Logger.clear();
});

async function lab(): Promise<{ sender: LinuxServer; collector: LinuxServer }> {
  const sw = new GenericSwitch('switch-generic', 'sw', 8, 0, 0);
  const sender = new LinuxServer('linux-server', 'sender', 0, 0);
  const collector = new LinuxServer('linux-server', 'collector', 0, 0);
  [sender, collector].forEach((d, i) => { new Cable(`c${i}`).connect(d.getPorts()[0], sw.getPorts()[i]); });
  sender.getPorts()[0].configureIP(new IPAddress('192.168.100.10'), new SubnetMask('255.255.255.0'));
  collector.getPorts()[0].configureIP(new IPAddress('192.168.100.50'), new SubnetMask('255.255.255.0'));
  [sender, collector, sw].forEach((d) => d.powerOn());
  await collector.executeCommand("sed -i 's/^#module(load=\"imudp\")/module(load=\"imudp\")/' /etc/rsyslog.conf");
  await collector.executeCommand("sed -i 's/^#input(type=\"imudp\" port=\"514\")/input(type=\"imudp\" port=\"514\")/' /etc/rsyslog.conf");
  await collector.executeCommand('systemctl restart rsyslog');
  return { sender, collector };
}

describe('logger -n over the wire', () => {
  it('the collector files the datagram sent by the real tool', async () => {
    const { sender, collector } = await lab();
    expect(await sender.executeCommand('logger -n 192.168.100.50 -t probe -p local3.notice "from the sender"')).toBe('');
    expect(await collector.executeCommand('grep "from the sender" /var/log/syslog')).toContain('probe');
  }, 30_000);

  it('the payload costs frames on the sender port', async () => {
    const { sender } = await lab();
    const framesOut = (): number => sender.getPorts()[0].getCounters().framesOut;
    await sender.executeCommand('logger -n 192.168.100.50 --no-act "warm up"');
    const before = framesOut();
    await sender.executeCommand('logger -n 192.168.100.50 --no-act "no payload"');
    const withoutPayload = framesOut() - before;
    const middle = framesOut();
    await sender.executeCommand('logger -n 192.168.100.50 "with payload"');
    expect(framesOut() - middle).toBeGreaterThan(withoutPayload);
  }, 30_000);

  it('a name that does not resolve is refused in the tool\'s words', async () => {
    const { sender } = await lab();
    expect(await sender.executeCommand('logger -n nosuch.invalid -P 514 hi')).toContain('failed to resolve name nosuch.invalid port 514: Name or service not known');
  }, 30_000);

  it('WITNESS -- local delivery still reaches the journal', async () => {
    const { sender } = await lab();
    await sender.executeCommand('logger -t probe "local line"');
    expect(await sender.executeCommand('journalctl -t probe -o cat')).toContain('local line');
  }, 30_000);

  it('WITNESS -- a collector whose imudp is not enabled files nothing', async () => {
    const { sender, collector } = await lab();
    await collector.executeCommand("sed -i 's/^module(load=\"imudp\")/#module(load=\"imudp\")/' /etc/rsyslog.conf");
    await collector.executeCommand('systemctl restart rsyslog');
    await sender.executeCommand('logger -n 192.168.100.50 -t witness "unheard"');
    expect(await collector.executeCommand('cat /var/log/syslog')).not.toContain('unheard');
  }, 30_000);
});
