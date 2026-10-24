/*
 * compatibility.configformat.{legacy,syslogd,property} of the ported rsyslog engine, ported from
 * runtime/glbl.c (permitCompatSyntax) and grammar/rainerscript.c (cnfstmtNewPRIFILT / cnfstmtNewPROPFILT) and
 * runtime/rsconf.c (cnfDoCfsysline). Each case drives a LinuxServer through its shell and reads the effect back from
 * the machine (config check output, exit code, files written by the daemon).
 * Measured against the previous commit: 6 of the 9 cases fall - the three policies were parsed as plain words and
 * never consulted, so a disabled syntax still ran, "warn" said nothing, and a bad value was accepted silently.
 * The three that pass either way are WITNESSES built in the same lab: the default policy keeps the legacy directive,
 * the classic selector and the property filter working, so the failures above are the policy and not the lab.
 * Time is the simulated clock; none of these cases waits for real time.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { MACAddress, resetCounters } from '@/network/core/types';
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

function lab(): LinuxServer {
  const server = new LinuxServer('linux-server', 'host1', 0, 0);
  server.powerOn();
  return server;
}

async function prepend(server: LinuxServer, text: string): Promise<void> {
  await server.executeCommand(`sed -i '1i ${text}' /etc/rsyslog.conf`);
}

async function check(server: LinuxServer): Promise<string> {
  return server.executeCommand('rsyslogd -N1 -f /etc/rsyslog.conf 2>&1; echo "exit=$?"');
}

describe('legacy $-directives', () => {
  it('disable refuses the directive with the source wording and the check fails', async () => {
    const host = lab();
    await prepend(host, 'global(compatibility.configformat.legacy="disable")');
    await host.executeCommand("printf '$FileCreateMode 0600\\n' > /etc/rsyslog.d/41-legacy.conf");
    const verdict = await check(host);
    expect(verdict).toContain(`obsolete $-directive syntax disabled: '$FileCreateMode 0600'; use global(compatibility.configformat.legacy="enable") to enable it`);
    expect(verdict).toContain('exit=1');
  }, 60_000);

  it('warn keeps the directive and says it is obsolete', async () => {
    const host = lab();
    await prepend(host, 'global(compatibility.configformat.legacy="warn")');
    await host.executeCommand("printf '$FileCreateMode 0600\\n' > /etc/rsyslog.d/41-legacy.conf");
    await host.executeCommand("printf 'local4.* /var/log/l4.log\\n' > /etc/rsyslog.d/42-l4.conf");
    expect(await check(host)).toContain(`obsolete $-directive syntax encountered: '$FileCreateMode 0600'`);
    await host.executeCommand('systemctl restart rsyslog');
    await host.executeCommand('logger -p local4.info -t probe keeps-working');
    expect((await host.executeCommand('stat -c %a /var/log/l4.log')).trim()).toBe('600');
  }, 60_000);

  it('witness: by default the directive is accepted without a word', async () => {
    const host = lab();
    await host.executeCommand("printf '$FileCreateMode 0600\\n' > /etc/rsyslog.d/41-legacy.conf");
    const verdict = await check(host);
    expect(verdict).not.toContain('obsolete');
    expect(verdict).toContain('exit=0');
  }, 60_000);
});

describe('classic syslogd selectors', () => {
  it('disable turns the selector line into a no-op so its action never runs', async () => {
    const host = lab();
    await prepend(host, 'global(compatibility.configformat.syslogd="disable")');
    await host.executeCommand("printf 'local4.* /var/log/l4.log\\n' > /etc/rsyslog.d/42-l4.conf");
    expect(await check(host)).toContain(`obsolete classic syslogd filter syntax disabled: 'local4.*'; use global(compatibility.configformat.syslogd="enable") to enable it`);
    await host.executeCommand('systemctl restart rsyslog');
    await host.executeCommand('logger -p local4.info -t probe dropped');
    expect(await host.executeCommand('ls /var/log/l4.log 2>&1')).toContain('No such file');
  }, 60_000);

  it('warn reports the selector and the rule still runs', async () => {
    const host = lab();
    await prepend(host, 'global(compatibility.configformat.syslogd="warn")');
    await host.executeCommand("printf 'local4.* /var/log/l4.log\\n' > /etc/rsyslog.d/42-l4.conf");
    expect(await check(host)).toContain(`obsolete classic syslogd filter syntax encountered: 'local4.*'`);
    await host.executeCommand('systemctl restart rsyslog');
    await host.executeCommand('logger -p local4.info -t probe still-runs');
    expect(await host.executeCommand('cat /var/log/l4.log')).toContain('probe: still-runs');
  }, 60_000);

  it('witness: by default the selector writes its file', async () => {
    const host = lab();
    await host.executeCommand("printf 'local4.* /var/log/l4.log\\n' > /etc/rsyslog.d/42-l4.conf");
    await host.executeCommand('systemctl restart rsyslog');
    await host.executeCommand('logger -p local4.info -t probe default');
    expect(await host.executeCommand('cat /var/log/l4.log')).toContain('probe: default');
  }, 60_000);
});

describe('classic property filters and bad values', () => {
  it('disable drops the property filter and its action', async () => {
    const host = lab();
    await prepend(host, 'global(compatibility.configformat.property="disable")');
    await host.executeCommand(`printf ':msg, contains, "needle" /var/log/needle.log\\n' > /etc/rsyslog.d/43-needle.conf`);
    expect(await check(host)).toContain(`obsolete classic property-based filter syntax disabled: ':msg, contains, "needle"'`);
    await host.executeCommand('systemctl restart rsyslog');
    await host.executeCommand('logger -t probe needle-in-haystack');
    expect(await host.executeCommand('ls /var/log/needle.log 2>&1')).toContain('No such file');
  }, 60_000);

  it('a value other than enable/warn/disable is refused with the source wording', async () => {
    const host = lab();
    await prepend(host, 'global(compatibility.configformat.legacy="maybe")');
    expect(await check(host)).toContain(`invalid value 'maybe' for global parameter compatibility.configformat.legacy`);
  }, 60_000);

  it('witness: the same property filter works by default', async () => {
    const host = lab();
    await host.executeCommand(`printf ':msg, contains, "needle" /var/log/needle.log\\n' > /etc/rsyslog.d/43-needle.conf`);
    await host.executeCommand('systemctl restart rsyslog');
    await host.executeCommand('logger -t probe needle-in-haystack');
    expect(await host.executeCommand('cat /var/log/needle.log')).toContain('needle-in-haystack');
  }, 60_000);
});
