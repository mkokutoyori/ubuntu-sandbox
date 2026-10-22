/*
 * The Linux rsyslog daemon is the ported engine (src/network/rsyslog) driven by LinuxRsyslogHost, not a line parser of its
 * own. Every case drives a LinuxServer through its shell, over a switch when two machines exchange messages.
 * Measured against the previous receiver (commit 16ee6d5b8, replayed in a worktree): 9 of the 13 cases fall - kill -HUP
 * killed the process, systemctl kill and absolute binary paths (/bin/systemctl) ran nothing, a rotated file kept receiving
 * lines, the -v header differed, forwarding did not cross a real TCP connection, and MARK, action resumption, extra
 * imuxsock sockets and terminals did not exist.
 * The four that pass either way: the boot lines (the old manager wrote them itself - a non-regression), the -N1 error
 * wording, and the two WITNESSES - a collector that does not load imtcp receives nothing, and mail.err is filed.
 * Time is the simulated clock: advanceTime() moves the machine clock and every timer of the daemon fires at its own due
 * time, so MARK lines are ten minutes apart in the file even though one call advanced forty.
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

function lab(count = 1): { servers: LinuxServer[] } {
  const sw = new GenericSwitch('switch-generic', 'sw', 8, 0, 0);
  const servers = Array.from({ length: count }, (_, index) => new LinuxServer('linux-server', `host${index + 1}`, 0, 0));
  servers.forEach((server, index) => {
    new Cable(`c${index}`).connect(server.getPorts()[0], sw.getPorts()[index]);
    server.getPorts()[0].configureIP(new IPAddress(`10.0.0.${index + 1}`), new SubnetMask('255.255.255.0'));
  });
  [...servers, sw].forEach((device) => device.powerOn());
  return { servers };
}

async function enableTcpReception(server: LinuxServer): Promise<void> {
  await server.executeCommand("sed -i 's/^#module(load=\"imtcp\")/module(load=\"imtcp\")/;s/^#input(type=\"imtcp\" port=\"514\")/input(type=\"imtcp\" port=\"514\")/' /etc/rsyslog.conf");
  await server.executeCommand('systemctl restart rsyslog');
}

async function forwardTo(server: LinuxServer, target: string): Promise<void> {
  await server.executeCommand(`printf '*.* @@${target}:514\\n' > /etc/rsyslog.d/90-forward.conf`);
  await server.executeCommand('systemctl restart rsyslog');
}

describe('boot, signals and rotation', () => {
  it('the boot lines are replayed through the rulesets with their boot-time stamps', async () => {
    const { servers: [host] } = lab();
    const kernel = await host.executeCommand('head -1 /var/log/kern.log');
    expect(kernel).toContain('kernel: Linux version');
    expect(await host.executeCommand('grep -c "logind" /var/log/auth.log')).not.toBe('0');
    expect(await host.executeCommand('grep -c "kernel:" /var/log/auth.log')).toBe('0');
  }, 30_000);

  it('kill -HUP and systemctl kill -s HUP keep the daemon alive and log the HUP', async () => {
    const { servers: [host] } = lab();
    const before = (await host.executeCommand('pidof rsyslogd')).trim();
    await host.executeCommand('kill -HUP $(pidof rsyslogd)');
    expect((await host.executeCommand('pidof rsyslogd')).trim()).toBe(before);
    expect((await host.executeCommand('grep -c "rsyslogd was HUPed" /var/log/syslog')).trim()).toBe('1');
    await host.executeCommand('logger -t probe holds-the-file-again');
    await host.executeCommand('rm /var/log/syslog');
    await host.executeCommand('logger -t probe lost-in-deleted-inode');
    expect(await host.executeCommand('cat /var/log/syslog')).toContain('No such file');
    await host.executeCommand('systemctl kill -s HUP rsyslog');
    await host.executeCommand('logger -t probe reopened');
    expect(await host.executeCommand('cat /var/log/syslog')).toContain('probe: reopened');
    expect((await host.executeCommand('pidof rsyslogd')).trim()).toBe(before);
  }, 30_000);

  it('a binary reached by its absolute path runs (/bin/systemctl)', async () => {
    const { servers: [host] } = lab();
    expect((await host.executeCommand('/bin/systemctl is-active rsyslog')).trim()).toBe('active');
  }, 30_000);

  it('logrotate renames the file, the postrotate HUP reopens it, new lines go to the new file', async () => {
    const { servers: [host] } = lab();
    await host.executeCommand('logger -t probe before-rotation');
    await host.executeCommand('logrotate -f /etc/logrotate.d/rsyslog');
    await host.executeCommand('logger -t probe after-rotation');
    expect(await host.executeCommand('cat /var/log/syslog')).toContain('after-rotation');
    expect(await host.executeCommand('cat /var/log/syslog')).not.toContain('before-rotation');
    expect(await host.executeCommand('cat /var/log/syslog.1')).toContain('before-rotation');
  }, 30_000);

  it('rsyslogd -v prints its header; WITNESS: unchanged from the previous command', async () => {
    const { servers: [host] } = lab();
    expect(await host.executeCommand('rsyslogd -v')).toContain('rsyslogd  8.2610.0 (aka 2021.12) compiled with:');
  }, 30_000);

  it('rsyslogd -N1 reports the first error of a bad rule and exits 1', async () => {
    const { servers: [host] } = lab();
    await host.executeCommand("printf 'local7.nolevel\\t/var/log/x.log\\n' > /etc/rsyslog.d/99-bad.conf");
    const out = await host.executeCommand('rsyslogd -N1; echo rc=$?');
    expect(out).toContain('unknown priority name "nolevel"');
    expect(out).toContain('rc=1');
    expect(out).not.toContain('End of config validation run');
  }, 30_000);
});

describe('network: real TCP frames between two machines', () => {
  it('a forwarding rule delivers to the collector, whose port counted the frames', async () => {
    const { servers: [sender, collector] } = lab(2);
    await enableTcpReception(collector);
    const framesIn = (): number => collector.getPorts()[0].getCounters().framesIn;
    await forwardTo(sender, '10.0.0.2');
    const before = framesIn();
    await sender.executeCommand('logger -t probe -p local3.notice central-line');
    expect(framesIn()).toBeGreaterThan(before);
    expect(await collector.executeCommand('grep central-line /var/log/syslog')).toContain('host1 probe: central-line');
  }, 30_000);

  it('WITNESS: a collector that does not load imtcp receives nothing', async () => {
    const { servers: [sender, collector] } = lab(2);
    await forwardTo(sender, '10.0.0.2');
    await sender.executeCommand('logger -t probe silent-line');
    expect(await collector.executeCommand('grep -c silent-line /var/log/syslog')).toBe('0');
  }, 30_000);

  it('a suspended action resumes after its interval on the simulated clock', async () => {
    const { servers: [sender, collector] } = lab(2);
    await forwardTo(sender, '10.0.0.2');
    await sender.executeCommand('logger -t probe lost-while-down');
    await enableTcpReception(collector);
    await sender.executeCommand('logger -t probe still-suspended');
    sender.advanceTime(31_000);
    await sender.executeCommand('logger -t probe after-resume');
    const received = await collector.executeCommand('cat /var/log/syslog');
    expect(received).not.toContain('lost-while-down');
    expect(received).not.toContain('still-suspended');
    expect(received).toContain('after-resume');
  }, 60_000);
});

describe('time, sockets and terminals', () => {
  it('MARK lines are written at their own due times when the clock jumps', async () => {
    const { servers: [host] } = lab();
    await host.executeCommand("printf '$RepeatedMsgReduction off\\nmodule(load=\"immark\" interval=\"600\")\\n' > /etc/rsyslog.d/30-mark.conf");
    await host.executeCommand('systemctl restart rsyslog');
    host.advanceTime(35 * 60_000);
    const marks = (await host.executeCommand('grep -- "-- MARK --" /var/log/syslog')).trim().split('\n');
    expect(marks).toHaveLength(3);
    const minutes = marks.map((line) => Number(/\d\d:(\d\d):\d\d/.exec(line)![1]));
    expect((minutes[1] - minutes[0] + 60) % 60).toBe(10);
    expect((minutes[2] - minutes[1] + 60) % 60).toBe(10);
  }, 30_000);

  it('an additional imuxsock socket receives what logger -u sends it', async () => {
    const { servers: [host] } = lab();
    await host.executeCommand("printf 'input(type=\"imuxsock\" socket=\"/var/run/postfix/log\" createPath=\"on\")\\n' > /etc/rsyslog.d/20-postfix.conf");
    await host.executeCommand('systemctl restart rsyslog');
    expect(await host.executeCommand('ls -l /var/run/postfix/')).toContain('srw-rw-rw-');
    await host.executeCommand('logger -u /var/run/postfix/log -t postfix chrooted-line');
    expect(await host.executeCommand('grep chrooted-line /var/log/syslog')).toContain('postfix: chrooted-line');
  }, 30_000);

  it('an emergency reaches the logged-in terminals', async () => {
    const { servers: [host] } = lab();
    const seen: string[] = [];
    host.getBus().subscribe('linux.tty.written', (event) => { seen.push(`${event.payload.tty}:${event.payload.text}`); });
    await host.executeCommand('who');
    await host.executeCommand('logger -p user.emerg -t probe system-is-going-down');
    expect(seen.some((entry) => entry.startsWith('tty1:') && entry.includes('system-is-going-down'))).toBe(true);
  }, 30_000);

  it('WITNESS: mail.err is filed under /var/log/mail.err by the Ubuntu default rules', async () => {
    const { servers: [host] } = lab();
    await host.executeCommand('logger -p mail.err -t postfix queue-broken');
    expect(await host.executeCommand('cat /var/log/mail.err')).toContain('queue-broken');
  }, 30_000);
});
