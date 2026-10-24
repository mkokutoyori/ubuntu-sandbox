/*
 * compatibility.configformat.{legacy,syslogd,property} of the ported rsyslog engine, ported from
 * runtime/glbl.c (permitCompatSyntax) and grammar/rainerscript.c (cnfstmtNewPRIFILT / cnfstmtNewPROPFILT) and
 * runtime/rsconf.c (cnfDoCfsysline), then the parameters that depend on how the daemon was built or on its signals:
 * libcapng.*, stdlog.channelSpec, defaultOpensslEngine (runtime/net_ossl.c), shutdown.enable.ctlc and the keep-running
 * bit of internal.developerOnly.options (tools/rsyslogd.c).
 * Each case drives a LinuxServer through its shell and reads the effect back from the machine (config check output,
 * exit code, files written by the daemon, service state).
 * Measured against the commit before each change: 11 of the 18 cases fall - 6 of the 9 configformat cases (the
 * policies were parsed as plain words and never consulted, so a disabled syntax still ran, "warn" said nothing and a bad
 * value was accepted) and 5 of the 9 others (the build-option parameters said nothing, SIGINT/SIGQUIT killed the
 * daemon whatever shutdown.enable.ctlc said, a missing OpenSSL engine was never reported and the developer option was
 * not read).
 * The seven that pass either way are WITNESSES built in the same lab: the default policy keeps the legacy directive, the
 * classic selector and the property filter working, a clean configuration raises none of the build-option messages,
 * the built-in engine and an unset engine raise nothing, SIGTERM stops the daemon whatever the switch, and a configuration without actions is refused without the developer option.
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

describe('build options and shutdown', () => {
  it('libcapng.* and stdlog.channelSpec fail in the words of a build without that support', async () => {
    const host = lab();
    await prepend(host, 'global(libcapng.enable="on" libcapng.default="on" stdlog.channelSpec="syslog:")');
    const verdict = await check(host);
    expect(verdict.match(/rsyslog wasn't compiled with libcap-ng support\./g)).toHaveLength(2);
    expect(verdict).toContain("rsyslog wasn't compiled with liblogging-stdlog support. The 'stdlog.channelspec' parameter is ignored. Note: the syslog API is used instead.");
  }, 60_000);

  it('witness: without those parameters the check is clean', async () => {
    const host = lab();
    const verdict = await check(host);
    expect(verdict).not.toContain("wasn't compiled");
    expect(verdict).toContain('exit=0');
  }, 60_000);

  it('SIGINT is ignored by default and stops the daemon with shutdown.enable.ctlc', async () => {
    const [ignoring, listening] = [lab(), lab()];
    await prepend(listening, 'global(shutdown.enable.ctlc="on")');
    for (const host of [ignoring, listening]) {
      await host.executeCommand('systemctl restart rsyslog');
      await host.executeCommand('kill -INT $(pidof rsyslogd)');
    }
    expect((await ignoring.executeCommand('systemctl is-active rsyslog')).trim()).toBe('active');
    expect((await listening.executeCommand('systemctl is-active rsyslog')).trim()).not.toBe('active');
    expect(await listening.executeCommand('cat /var/log/syslog')).toContain('exiting on signal 2.');
  }, 60_000);

  it('SIGQUIT follows the same switch', async () => {
    const [ignoring, listening] = [lab(), lab()];
    await prepend(listening, 'global(shutdown.enable.ctlc="on")');
    for (const host of [ignoring, listening]) {
      await host.executeCommand('systemctl restart rsyslog');
      await host.executeCommand('kill -QUIT $(pidof rsyslogd)');
    }
    expect((await ignoring.executeCommand('systemctl is-active rsyslog')).trim()).toBe('active');
    expect((await listening.executeCommand('systemctl is-active rsyslog')).trim()).not.toBe('active');
  }, 60_000);

  it('witness: SIGTERM stops the daemon whatever the switch', async () => {
    const host = lab();
    await host.executeCommand('systemctl restart rsyslog');
    await host.executeCommand('kill -TERM $(pidof rsyslogd)');
    expect((await host.executeCommand('systemctl is-active rsyslog')).trim()).not.toBe('active');
  }, 60_000);

  it('an OpenSSL engine the machine does not have is reported when the ossl driver starts', async () => {
    const host = lab();
    await prepend(host, 'global(defaultOpensslEngine="nonesuch")');
    await host.executeCommand('touch /usr/lib/x86_64-linux-gnu/rsyslog/lmnsd_ossl.so');
    await host.executeCommand(`printf '*.* action(type="omfwd" target="10.0.0.9" port="6514" protocol="tcp" StreamDriver="ossl" StreamDriverMode="1" StreamDriverAuthMode="anon")\\n' > /etc/rsyslog.d/44-tls.conf`);
    expect(await check(host)).toContain("error: ENGINE_init failed to load Engine 'nonesuch'ossl netstream driver");
  }, 60_000);

  it('witness: the built-in dynamic engine and an unset engine raise nothing', async () => {
    const [dynamic, unset] = [lab(), lab()];
    await prepend(dynamic, 'global(defaultOpensslEngine="dynamic")');
    for (const host of [dynamic, unset]) {
      await host.executeCommand('touch /usr/lib/x86_64-linux-gnu/rsyslog/lmnsd_ossl.so');
      await host.executeCommand(`printf '*.* action(type="omfwd" target="10.0.0.9" port="6514" protocol="tcp" StreamDriver="ossl" StreamDriverMode="1" StreamDriverAuthMode="anon")\\n' > /etc/rsyslog.d/44-tls.conf`);
      expect(await check(host)).not.toContain('ENGINE_init');
    }
  }, 60_000);

  const INPUTS_ONLY = 'module(load="imudp")\ninput(type="imudp" port="514")\n';

  async function inputsOnly(host: LinuxServer, header: string): Promise<void> {
    await host.executeCommand(`printf '${header}${INPUTS_ONLY}' > /etc/rsyslog.conf`);
  }

  it('the developer-only keep-running bit lets a configuration without actions start, with the source note', async () => {
    const host = lab();
    await inputsOnly(host, 'global(internal.developerOnly.options="1")\\n');
    expect(await check(host)).toContain('rsyslogd: NOTE: developer-only option set to keep rsyslog running where it should abort - this can lead to more problems later in the run.');
    await host.executeCommand('systemctl restart rsyslog');
    expect((await host.executeCommand('systemctl is-active rsyslog')).trim()).toBe('active');
  }, 60_000);

  it('witness: the same configuration without that option is refused', async () => {
    const host = lab();
    await inputsOnly(host, '');
    const verdict = await check(host);
    expect(verdict).toContain('there are no active actions configured');
    expect(verdict).not.toContain('developer-only');
    await host.executeCommand('systemctl restart rsyslog');
    expect((await host.executeCommand('systemctl is-active rsyslog')).trim()).not.toBe('active');
  }, 60_000);
});
