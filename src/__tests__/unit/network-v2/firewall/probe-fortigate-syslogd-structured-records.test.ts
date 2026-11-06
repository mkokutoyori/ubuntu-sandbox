/*
 * Probe: `config log syslogd setting` forwarded Cisco-ASA-styled text ("%FORTIGATE-0000000015: Deny ICMP src ...")
 * built from a catalog meant for the ASA, taken before the structured log record, and ignored `format` altogether
 * (accepted, stored, rendered, never read). A real FortiGate sends the log record itself: `<PRI>` followed directly
 * by the record, key=value in the `default` format (the same record `execute log display` already renders through
 * formatLogRecord), csv, cef, or rfc5424. The collector now receives those records, filtered by `config log
 * syslogd filter` (severity, forward-traffic), including the event log (configuration changes), and the legacy
 * ASA-styled leg is no longer sent for FortiOS.
 *
 * rsyslog stamps the receive time and the sender address on a line that carries no header, which is what the
 * collector's /var/log/syslog shows here as it does on a real host.
 *
 * Discriminated with git stash on src/network: 6 of 7 fall before the fix; the witness (a collector that is
 * declared receives the deny of a `logtraffic all` policy) passes either way, in the old text and the new record.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { FortiGate } from '@/network/devices/firewall/vendors/fortios/FortiGate';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { GenericSwitch } from '@/network/devices/GenericSwitch';
import { Cable } from '@/network/hardware/Cable';
import { resetCounters, MACAddress } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';

beforeEach(() => {
  resetCounters(); resetDeviceCounters(); MACAddress.resetCounter(); Logger.reset(); EquipmentRegistry.resetInstance();
});

interface Cmd { executeCommand(cmd: string): Promise<string> }

async function run(device: Cmd, ...lines: string[]): Promise<void> {
  for (const line of lines) await device.executeCommand(line);
}

const LISTEN_UDP = [
  'sed -i \'s/^#module(load="imudp")/module(load="imudp")/\' /etc/rsyslog.conf',
  'sed -i \'s/^#input(type="imudp" port="514")/input(type="imudp" port="514")/\' /etc/rsyslog.conf',
  'systemctl restart rsyslog',
];

async function lab(collectorSettings: string[] = []) {
  const fgt = new FortiGate('firewall-fortinet', 'FGT', 0, 0);
  const sw = new GenericSwitch('switch-generic', 'SW', 8, 0, 0);
  const collector = new LinuxServer('linux-server', 'LOG', 0, 0);
  const pc = new LinuxPC('linux-pc', 'PC', 0, 0);
  for (const device of [fgt, sw, collector, pc]) device.powerOn();
  new Cable('u').connect(fgt.getPort('port1')!, sw.getPort('eth0')!);
  new Cable('a').connect(collector.getPort('eth0')!, sw.getPort('eth1')!);
  new Cable('b').connect(pc.getPort('eth0')!, sw.getPort('eth2')!);

  await run(fgt,
    'config system interface',
    'edit "port1"', 'set mode static', 'set ip 192.168.1.1 255.255.255.0', 'set allowaccess ping', 'next',
    'edit "port2"', 'set mode static', 'set ip 203.0.113.1 255.255.255.0', 'next', 'end');
  await run(collector, 'ip link set eth0 up', 'ip addr add 192.168.1.53/24 dev eth0', ...LISTEN_UDP);
  await run(pc, 'ip link set eth0 up', 'ip addr add 192.168.1.10/24 dev eth0', 'ip route add default via 192.168.1.1');
  await run(fgt,
    'config log syslogd setting', 'set status enable', 'set server "192.168.1.53"', ...collectorSettings, 'end',
    'config firewall policy', 'edit 1', 'set srcintf "port1"', 'set dstintf "port2"', 'set srcaddr "all"',
    'set dstaddr "all"', 'set action deny', 'set schedule "always"', 'set service "ALL"',
    'set logtraffic all', 'next', 'end');
  await pc.executeCommand('ping -c 1 -W 1 203.0.113.10');
  return { fgt, collector, pc };
}

const received = (collector: Cmd) => collector.executeCommand('cat /var/log/syslog');

describe('config log syslogd setting forwards the structured log records', () => {
  it('witness: the declared collector receives the deny of a logtraffic all policy', async () => {
    const { collector } = await lab();
    expect(await received(collector)).toMatch(/203\.0\.113\.10/);
  });

  it('default format is the key=value record, with no ASA-styled text', async () => {
    const { collector } = await lab();
    const journal = await received(collector);
    expect(journal).toMatch(/date=\S+ time=\S+ eventtime=\d+ logid="0000000015" type="traffic" subtype="forward" level="warning"/);
    expect(journal).toMatch(/srcip=192\.168\.1\.10 .*dstip=203\.0\.113\.10 .*action="deny" policyid=1/);
    expect(journal).not.toContain('%FORTIGATE');
  });

  it('format csv sends the comma separated record', async () => {
    const { collector } = await lab(['set format csv']);
    expect(await received(collector)).toMatch(/"0000000015","traffic","forward","warning"/);
  });

  it('format rfc5424 sends the structured-data record', async () => {
    const { collector } = await lab(['set format rfc5424']);
    expect(await received(collector)).toMatch(/^\w{3} +\d+ \d\d:\d\d:\d\d FGT FortiGate *$/m);
  });

  it('format cef sends the CEF record', async () => {
    const { collector } = await lab(['set format cef']);
    expect(await received(collector)).toMatch(/ CEF: 0\|Fortinet\|Fortigate\|[^|]*\|0000000015\|traffic:forward\|5\|date=/);
  });

  it('the event log is forwarded too: a configuration change reaches the collector', async () => {
    const { collector } = await lab();
    expect(await received(collector)).toMatch(/type="event" subtype="system".*cfgpath="firewall\.policy"/);
  });

  it('forward-traffic disable on the syslogd filter withholds the forward traffic record', async () => {
    const { fgt, collector, pc } = await lab();
    expect(await received(collector)).toMatch(/type="traffic"/);
    await run(fgt, 'config log syslogd filter', 'set forward-traffic disable', 'end');
    await collector.executeCommand('truncate -s 0 /var/log/syslog');
    await pc.executeCommand('ping -c 1 -W 1 203.0.113.11');
    expect(await received(collector)).not.toMatch(/type="traffic"/);
  });
});
