/*
 * Global parameters of the ported rsyslog engine that used to be parsed, stored and never evaluated: privilege drop,
 * maxOpenFiles, umask, abortOnUncleanConfig, inputStartupPolicy and the oversize-message handling. Each case drives a
 * LinuxServer through its shell and reads the effect back from the machine (process table, files, journal, exit codes).
 * Measured against the previous commit (941b21efa): 11 of the 15 cases fall - the identity never changed, the file
 * limit and the umask were never applied, a dirty configuration always started, a failed input never aborted the start,
 * and a message longer than maxMessageSize was cut silently (no warning, no error file, no split/accept mode).
 * The four that pass either way are WITNESSES built in the same lab: the same rule without privdrop creates its file
 * as root, a generous maxOpenFiles lets every file open, the dirty configuration starts without abortOnUncleanConfig,
 * and a message within the limit is neither reported nor recorded - so the failures above are the parameter and not
 * the lab.
 * Time is the simulated clock; none of these cases waits for real time.
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

function lab(count = 1): LinuxServer[] {
  const sw = new GenericSwitch('switch-generic', 'sw', 8, 0, 0);
  const servers = Array.from({ length: count }, (_, index) => new LinuxServer('linux-server', `host${index + 1}`, 0, 0));
  servers.forEach((server, index) => {
    new Cable(`c${index}`).connect(server.getPorts()[0], sw.getPorts()[index]);
    server.getPorts()[0].configureIP(new IPAddress(`10.0.0.${index + 1}`), new SubnetMask('255.255.255.0'));
  });
  [...servers, sw].forEach((device) => device.powerOn());
  return servers;
}

async function prepend(server: LinuxServer, text: string): Promise<void> {
  await server.executeCommand(`sed -i '1i ${text}' /etc/rsyslog.conf`);
}

async function enableUdp(server: LinuxServer): Promise<void> {
  await server.executeCommand("sed -i 's/^#module(load=\"imudp\")/module(load=\"imudp\")/;s/^#input(type=\"imudp\" port=\"514\")/input(type=\"imudp\" port=\"514\")/' /etc/rsyslog.conf");
}

async function status(server: LinuxServer): Promise<string> {
  return (await server.executeCommand('systemctl is-active rsyslog')).trim();
}

describe('privilege drop', () => {
  it('the daemon runs under the configured identity and its files obey it', async () => {
    const [host] = lab();
    await host.executeCommand('useradd -r -M -s /usr/sbin/nologin syslog');
    const uid = (await host.executeCommand('id -u syslog')).trim();
    await host.executeCommand('chown syslog:adm /var/log/syslog');
    await prepend(host, 'global(privdrop.user.name="syslog" privdrop.group.name="adm")');
    await host.executeCommand("printf 'local4.* /var/log/local4.log\\n' > /etc/rsyslog.d/40-local4.conf");
    await host.executeCommand('systemctl restart rsyslog');
    expect(await status(host)).toBe('active');
    expect((await host.executeCommand('ps -o user= -p $(pidof rsyslogd)')).trim()).toBe('syslog');
    expect(await host.executeCommand('grep -c "rsyslogd\'s userid changed to ' + uid + '" /var/log/syslog')).toContain('1');
    expect(await host.executeCommand('grep -c "rsyslogd\'s groupid changed to 4" /var/log/syslog')).toContain('1');
    await host.executeCommand('logger -p local4.info -t probe cannot-create-in-var-log');
    expect(await host.executeCommand('ls /var/log/local4.log 2>&1')).toContain('No such file');
    expect(await host.executeCommand('grep -c "open file \'/var/log/local4.log\' failed: Permission denied" /var/log/syslog')).not.toBe('0');
    await host.executeCommand('logger -t probe still-writes-the-owned-file');
    expect(await host.executeCommand('cat /var/log/syslog')).toContain('probe: still-writes-the-owned-file');
  }, 60_000);

  it('witness: without privdrop the same rule creates the file as root', async () => {
    const [host] = lab();
    await host.executeCommand("printf 'local4.* /var/log/local4.log\\n' > /etc/rsyslog.d/40-local4.conf");
    await host.executeCommand('systemctl restart rsyslog');
    expect((await host.executeCommand('ps -o user= -p $(pidof rsyslogd)')).trim()).toBe('root');
    await host.executeCommand('logger -p local4.info -t probe created-as-root');
    expect(await host.executeCommand('cat /var/log/local4.log')).toContain('probe: created-as-root');
    expect((await host.executeCommand('stat -c %U /var/log/local4.log')).trim()).toBe('root');
  }, 60_000);

  it('chown to another owner is refused after the drop and fails the open when failOnChownFailure is on', async () => {
    const [host] = lab();
    await host.executeCommand('useradd -r -M -s /usr/sbin/nologin syslog');
    await host.executeCommand('chown syslog:adm /var/log /var/log/syslog');
    await prepend(host, 'global(privdrop.user.name="syslog" privdrop.group.name="adm")');
    await host.executeCommand("printf 'local4.* action(type=\"omfile\" file=\"/var/log/owned.log\" fileOwner=\"root\" failOnChownFailure=\"on\")\\n' > /etc/rsyslog.d/40-owned.conf");
    await host.executeCommand('systemctl restart rsyslog');
    await host.executeCommand('logger -p local4.info -t probe chown-must-fail');
    const journal = await host.executeCommand('cat /var/log/syslog');
    expect(journal).toContain("omfile: chown for file '/var/log/owned.log' failed: Operation not permitted");
    expect((await host.executeCommand('stat -c %U /var/log/owned.log')).trim()).toBe('syslog');
  }, 60_000);
});

describe('file limit and umask', () => {
  it('maxOpenFiles bounds the descriptors the daemon may hold', async () => {
    const [host] = lab();
    await prepend(host, 'global(maxOpenFiles="6")');
    await host.executeCommand("printf 'local4.* /var/log/a.log\\nlocal5.* /var/log/b.log\\nlocal6.* /var/log/c.log\\nlocal7.* /var/log/d.log\\n' > /etc/rsyslog.d/40-many.conf");
    await host.executeCommand('systemctl restart rsyslog');
    for (const facility of ['local4', 'local5', 'local6', 'local7']) await host.executeCommand(`logger -p ${facility}.info -t probe ${facility}`);
    expect(await host.executeCommand('cat /var/log/syslog')).toContain('Too many open files');
    const written = await host.executeCommand('ls /var/log/a.log /var/log/b.log /var/log/c.log /var/log/d.log 2>&1');
    expect(written).toContain('No such file');
  }, 60_000);

  it('witness: a generous maxOpenFiles lets every file open', async () => {
    const [host] = lab();
    await prepend(host, 'global(maxOpenFiles="200")');
    await host.executeCommand("printf 'local4.* /var/log/a.log\\nlocal5.* /var/log/b.log\\nlocal6.* /var/log/c.log\\nlocal7.* /var/log/d.log\\n' > /etc/rsyslog.d/40-many.conf");
    await host.executeCommand('systemctl restart rsyslog');
    for (const facility of ['local4', 'local5', 'local6', 'local7']) await host.executeCommand(`logger -p ${facility}.info -t probe ${facility}`);
    expect(await host.executeCommand('cat /var/log/a.log /var/log/b.log /var/log/c.log /var/log/d.log')).toContain('probe: local7');
    expect(await host.executeCommand('cat /var/log/syslog')).not.toContain('Too many open files');
  }, 60_000);

  it('a limit above the kernel ceiling fails the activation with the source wording', async () => {
    const [host] = lab();
    await prepend(host, 'global(maxOpenFiles="2000000")');
    const refused = await host.executeCommand('systemctl restart rsyslog');
    expect(await status(host)).not.toBe('active');
    expect(refused + (await host.executeCommand('journalctl -u rsyslog --no-pager 2>&1; cat /var/log/syslog'))).toMatch(/could not set process file limit to 2000000 \[current hard limit \d+\]: Operation not permitted/);
  }, 60_000);

  it('umask masks the creation mode of the files the daemon creates', async () => {
    const [host] = lab();
    await host.executeCommand("sed -i 's/^\\$Umask 0022/global(umask=\"0077\")/' /etc/rsyslog.conf");
    await host.executeCommand("printf 'local4.* action(type=\"omfile\" file=\"/var/log/masked.log\" fileCreateMode=\"0644\")\\n' > /etc/rsyslog.d/40-masked.conf");
    await host.executeCommand('systemctl restart rsyslog');
    await host.executeCommand('logger -p local4.info -t probe masked');
    expect((await host.executeCommand('stat -c %a /var/log/masked.log')).trim()).toBe('600');
  }, 60_000);
});

describe('startup policy', () => {
  it('abortOnUncleanConfig refuses to start on a dirty configuration, -N1 exits 2', async () => {
    const [host] = lab();
    await prepend(host, 'global(abortOnUncleanConfig="on")');
    await host.executeCommand("printf 'if $msg contains then\\n' > /etc/rsyslog.d/45-dirty.conf");
    const verdict = await host.executeCommand('rsyslogd -N1 -f /etc/rsyslog.conf; echo "exit=$?"');
    expect(verdict).toContain('AbortOnUncleanConfig="on") is set, and config is not clean');
    expect(verdict).toContain('exit=2');
    await host.executeCommand('systemctl restart rsyslog');
    expect(await status(host)).not.toBe('active');
  }, 60_000);

  it('witness: the same dirty configuration starts without abortOnUncleanConfig', async () => {
    const [host] = lab();
    await host.executeCommand("printf 'if $msg contains then\\n' > /etc/rsyslog.d/45-dirty.conf");
    await host.executeCommand('systemctl restart rsyslog');
    expect(await status(host)).toBe('active');
    expect(await host.executeCommand('rsyslogd -N1 -f /etc/rsyslog.conf; echo "exit=$?"')).toContain('exit=1');
  }, 60_000);

  it('inputStartupPolicy require-all aborts when a listener cannot bind, best-effort keeps what works', async () => {
    const [strict, lenient] = lab(2);
    for (const host of [strict, lenient]) {
      await enableUdp(host);
      await host.executeCommand("printf 'input(type=\"imudp\" port=\"514\")\\n' > /etc/rsyslog.d/46-twice.conf");
    }
    await prepend(strict, 'global(inputStartupPolicy="require-all")');
    await strict.executeCommand('systemctl restart rsyslog');
    expect(await status(strict)).not.toBe('active');
    expect(await strict.executeCommand('journalctl -t rsyslogd --no-pager')).toContain('activation of module imudp failed');
    await lenient.executeCommand('systemctl restart rsyslog');
    expect(await status(lenient)).toBe('active');
  }, 60_000);

  it('require-all turns an input declaration that failed into a configuration error', async () => {
    const [host] = lab();
    await prepend(host, 'global(inputStartupPolicy="require-all")');
    await host.executeCommand("printf 'input(type=\"imnothing\" port=\"1\")\\n' > /etc/rsyslog.d/46-unknown.conf");
    const out = await host.executeCommand('rsyslogd -N1 -f /etc/rsyslog.conf; echo "exit=$?"');
    expect(out).toContain('run failed with error -2046');
    expect(out).toContain('exit=1');
  }, 60_000);
});

describe('oversize messages', () => {
  async function oversizeLab(mode: string | null): Promise<{ collector: LinuxServer; sender: LinuxServer }> {
    const [collector, sender] = lab(2);
    await enableUdp(collector);
    const modeParam = mode === null ? '' : ` oversizemsg.input.mode="${mode}"`;
    await prepend(collector, `global(maxMessageSize="256" oversizemsg.errorfile="/var/log/oversize.json"${modeParam})`);
    await collector.executeCommand("printf 'if $fromhost-ip == \"10.0.0.2\" then /var/log/remote.log\\n' > /etc/rsyslog.d/30-remote.conf");
    await collector.executeCommand('systemctl restart rsyslog');
    await sender.executeCommand("printf '*.* @10.0.0.1:514\\n' > /etc/rsyslog.d/90-forward.conf");
    await sender.executeCommand('systemctl restart rsyslog');
    return { collector, sender };
  }

  const long = 'x'.repeat(600);

  it('truncate (the default) cuts the message, warns, and records the original in the error file', async () => {
    const { collector, sender } = await oversizeLab(null);
    await sender.executeCommand(`logger -t big ${long}`);
    const filed = await collector.executeCommand('cat /var/log/remote.log');
    expect(filed.length).toBeGreaterThan(0);
    expect(filed).not.toContain('x'.repeat(300));
    expect(await collector.executeCommand('grep -c "message too long (" /var/log/syslog')).not.toBe('0');
    expect(await collector.executeCommand('cat /var/log/syslog')).toContain('with configured size 256, begin of message is: ');
    const record = await collector.executeCommand('cat /var/log/oversize.json');
    expect(record).toContain('"rawmsg": "');
    expect(record).toContain('"input": "imudp"');
    expect(record).toContain('x'.repeat(300));
  }, 90_000);

  it('split files the surplus as further messages', async () => {
    const { collector, sender } = await oversizeLab('split');
    await sender.executeCommand(`logger -t big ${long}`);
    const lines = (await collector.executeCommand('wc -l < /var/log/remote.log')).trim();
    expect(Number(lines)).toBeGreaterThanOrEqual(3);
    expect((await collector.executeCommand('cat /var/log/remote.log')).replace(/[^x]/g, '').length).toBeGreaterThanOrEqual(600);
  }, 90_000);

  it('accept keeps the whole message', async () => {
    const { collector, sender } = await oversizeLab('accept');
    await sender.executeCommand(`logger -t big ${long}`);
    expect(await collector.executeCommand('cat /var/log/remote.log')).toContain('x'.repeat(600));
    expect(await collector.executeCommand('cat /var/log/oversize.json')).toContain('x'.repeat(300));
  }, 90_000);

  it('witness: a message within the limit is neither reported nor recorded', async () => {
    const { collector, sender } = await oversizeLab(null);
    await sender.executeCommand('logger -t small short-message');
    expect(await collector.executeCommand('cat /var/log/remote.log')).toContain('short-message');
    expect(await collector.executeCommand('cat /var/log/syslog')).not.toContain('message too long');
    expect(await collector.executeCommand('cat /var/log/oversize.json 2>&1')).toContain('No such file');
  }, 90_000);
});
