import { describe, it, expect, beforeEach } from 'vitest';
import { IPAddress, SubnetMask, resetCounters } from '@/network/core/types';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { Cable } from '@/network/hardware/Cable';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { VirtualFileSystem } from '@/network/devices/linux/VirtualFileSystem';
import { LinuxProcessManager } from '@/network/devices/linux/LinuxProcessManager';
import { LinuxServiceManager } from '@/network/devices/linux/LinuxServiceManager';
import { cmdSystemctl } from '@/network/devices/linux/LinuxProcessCommands';
import { parseTimeSpan } from '@/network/devices/linux/systemd/TimeSpan';

const UNIT_DIR = '/usr/lib/systemd/system';
const SERVICE_BODY = ['[Unit]', '[Service]', 'ExecStart=/x'].join('\n');

function buildStack(units: Record<string, string>) {
  const vfs = new VirtualFileSystem();
  const sm = new LinuxServiceManager(vfs, new LinuxProcessManager(), { isServer: false });
  for (const [name, body] of Object.entries(units)) {
    const file = /\.(target|socket|timer)$/.test(name) ? name : `${name}.service`;
    vfs.writeFile(`${UNIT_DIR}/${file}`, body, 0, 0, 0o644);
  }
  sm.daemonReload();
  return { vfs, sm };
}

function secondsAfter(base: Date, seconds: number): Date {
  return new Date(base.getTime() + seconds * 1000);
}

describe('parseTimeSpan', () => {
  it('parses bare numbers as seconds', () => {
    expect(parseTimeSpan('30')).toBe(30);
  });

  it('parses unit suffixes and compound spans', () => {
    expect(parseTimeSpan('5s')).toBe(5);
    expect(parseTimeSpan('2min')).toBe(120);
    expect(parseTimeSpan('1h 30min')).toBe(5400);
    expect(parseTimeSpan('1d')).toBe(86400);
  });

  it('rejects unknown units', () => {
    expect(parseTimeSpan('5 parsecs')).toBeUndefined();
  });
});

describe('systemd .timer units', () => {
  it('loads a .timer unit and start activates it without a process', () => {
    const { sm } = buildStack({
      'backup.timer': ['[Unit]', '[Timer]', 'OnActiveSec=30'].join('\n'),
      backup: SERVICE_BODY,
    });

    const result = sm.start('backup.timer');

    expect(result.ok).toBe(true);
    const u = sm.status('backup.timer')!;
    expect(u.state).toBe('active');
    expect(u.mainPid).toBeUndefined();
  });

  it('fires the matching service when OnActiveSec elapses', () => {
    const { sm } = buildStack({
      'backup.timer': ['[Unit]', '[Timer]', 'OnActiveSec=30'].join('\n'),
      backup: SERVICE_BODY,
    });
    const armedAt = new Date();
    sm.start('backup.timer');

    sm.timerTick(secondsAfter(armedAt, 20));
    expect(sm.isActive('backup')).toBe(false);

    sm.timerTick(secondsAfter(armedAt, 40));
    expect(sm.isActive('backup')).toBe(true);
  });

  it('does not re-fire a one-shot OnActiveSec timer', () => {
    const { sm } = buildStack({
      'backup.timer': ['[Unit]', '[Timer]', 'OnActiveSec=10'].join('\n'),
      backup: SERVICE_BODY,
    });
    const armedAt = new Date();
    sm.start('backup.timer');
    sm.timerTick(secondsAfter(armedAt, 15));
    expect(sm.isActive('backup')).toBe(true);
    sm.stop('backup');

    sm.timerTick(secondsAfter(armedAt, 3600));

    expect(sm.isActive('backup')).toBe(false);
  });

  it('OnUnitActiveSec re-fires after the previous trigger', () => {
    const { sm } = buildStack({
      'backup.timer': ['[Unit]', '[Timer]', 'OnActiveSec=10', 'OnUnitActiveSec=60'].join('\n'),
      backup: SERVICE_BODY,
    });
    const armedAt = new Date();
    sm.start('backup.timer');
    sm.timerTick(secondsAfter(armedAt, 15));
    expect(sm.isActive('backup')).toBe(true);
    sm.stop('backup');

    sm.timerTick(secondsAfter(armedAt, 40));
    expect(sm.isActive('backup')).toBe(false);

    sm.timerTick(secondsAfter(armedAt, 90));
    expect(sm.isActive('backup')).toBe(true);
  });

  it('stopping the timer disarms it', () => {
    const { sm } = buildStack({
      'backup.timer': ['[Unit]', '[Timer]', 'OnActiveSec=10'].join('\n'),
      backup: SERVICE_BODY,
    });
    const armedAt = new Date();
    sm.start('backup.timer');
    sm.stop('backup.timer');

    sm.timerTick(secondsAfter(armedAt, 3600));

    expect(sm.isActive('backup')).toBe(false);
    expect(sm.isActive('backup.timer')).toBe(false);
  });

  it('Unit= overrides the activated service', () => {
    const { sm } = buildStack({
      'cleanup.timer': ['[Unit]', '[Timer]', 'OnActiveSec=10', 'Unit=purge.service'].join('\n'),
      purge: SERVICE_BODY,
    });
    const armedAt = new Date();
    sm.start('cleanup.timer');

    sm.timerTick(secondsAfter(armedAt, 15));

    expect(sm.isActive('purge')).toBe(true);
  });

  it('OnCalendar=hourly fires at the top of the next hour', () => {
    const { sm } = buildStack({
      'report.timer': ['[Unit]', '[Timer]', 'OnCalendar=hourly'].join('\n'),
      report: SERVICE_BODY,
    });
    const armedAt = new Date();
    sm.start('report.timer');
    const nextHour = new Date(armedAt);
    nextHour.setMinutes(0, 0, 0);
    nextHour.setHours(nextHour.getHours() + 1);

    sm.timerTick(new Date(nextHour.getTime() - 5000));
    expect(sm.isActive('report')).toBe(false);

    sm.timerTick(new Date(nextHour.getTime() + 5000));
    expect(sm.isActive('report')).toBe(true);
  });

  it('systemctl list-timers shows the armed timer and what it activates', () => {
    const { sm } = buildStack({
      'backup.timer': ['[Unit]', '[Timer]', 'OnActiveSec=30'].join('\n'),
      backup: SERVICE_BODY,
    });
    sm.start('backup.timer');

    const out = cmdSystemctl(['list-timers'], sm);

    expect(out.exitCode).toBe(0);
    expect(out.output).toContain('backup.timer');
    expect(out.output).toContain('backup.service');
    expect(out.output).toContain('1 timers listed.');
  });
});

describe('systemd .socket units', () => {
  const SOCKET_BODY = ['[Unit]', '[Socket]', 'ListenStream=7777'].join('\n');

  it('loads a .socket unit and start activates it without a process', () => {
    const { sm } = buildStack({ 'echo.socket': SOCKET_BODY, echo: SERVICE_BODY });

    const result = sm.start('echo.socket');

    expect(result.ok).toBe(true);
    const u = sm.status('echo.socket')!;
    expect(u.state).toBe('active');
    expect(u.mainPid).toBeUndefined();
  });

  it('exposes the listen port as a systemd-owned port binding', () => {
    const { sm } = buildStack({ 'echo.socket': SOCKET_BODY, echo: SERVICE_BODY });
    sm.start('echo.socket');

    const binding = sm.getPortBinding('echo.socket')!;

    expect(binding.processName).toBe('systemd');
    expect(binding.sockets).toEqual([{ port: 7777, protocol: 'tcp' }]);
  });

  it('a connection trigger starts the matching service', () => {
    const { sm } = buildStack({ 'echo.socket': SOCKET_BODY, echo: SERVICE_BODY });
    sm.start('echo.socket');
    expect(sm.isActive('echo')).toBe(false);

    const result = sm.triggerSocket('echo.socket');

    expect(result.ok).toBe(true);
    expect(sm.isActive('echo')).toBe(true);
  });

  it('an inactive socket refuses the trigger', () => {
    const { sm } = buildStack({ 'echo.socket': SOCKET_BODY, echo: SERVICE_BODY });

    const result = sm.triggerSocket('echo.socket');

    expect(result.ok).toBe(false);
    expect(sm.isActive('echo')).toBe(false);
  });

  it('Service= overrides the activated service', () => {
    const { sm } = buildStack({
      'proxy.socket': ['[Unit]', '[Socket]', 'ListenStream=8080', 'Service=gateway.service'].join('\n'),
      gateway: SERVICE_BODY,
    });
    sm.start('proxy.socket');

    sm.triggerSocket('proxy.socket');

    expect(sm.isActive('gateway')).toBe(true);
  });

  it('systemctl list-sockets shows the listening socket', () => {
    const { sm } = buildStack({ 'echo.socket': SOCKET_BODY, echo: SERVICE_BODY });
    sm.start('echo.socket');

    const out = cmdSystemctl(['list-sockets'], sm);

    expect(out.exitCode).toBe(0);
    expect(out.output).toContain('0.0.0.0:7777');
    expect(out.output).toContain('echo.socket');
    expect(out.output).toContain('echo.service');
    expect(out.output).toContain('1 sockets listed.');
  });

  it('systemctl status renders active (listening) for a socket unit', () => {
    const { sm } = buildStack({ 'echo.socket': SOCKET_BODY, echo: SERVICE_BODY });
    sm.start('echo.socket');

    const out = cmdSystemctl(['status', 'echo.socket'], sm);

    expect(out.output).toContain('echo.socket');
    expect(out.output).toContain('active (listening)');
  });
});

describe('socket activation over a real cable', () => {
  const SERVER_IP = '10.9.0.1';
  const CLIENT_IP = '10.9.0.2';

  function vfsOf(pc: LinuxPC): VirtualFileSystem {
    return (pc as unknown as { executor: { vfs: VirtualFileSystem } }).executor.vfs;
  }

  beforeEach(() => {
    resetCounters();
    resetDeviceCounters();
    Logger.clear();
  });

  async function buildLab() {
    const server = new LinuxPC('linux-pc', 'SRV');
    const client = new LinuxPC('linux-pc', 'CLI');
    server.configureInterface('eth0', new IPAddress(SERVER_IP), new SubnetMask('255.255.255.0'));
    client.configureInterface('eth0', new IPAddress(CLIENT_IP), new SubnetMask('255.255.255.0'));
    const cable = new Cable('c1');
    cable.connect(server.getPort('eth0')!, client.getPort('eth0')!);

    vfsOf(server).writeFile('/etc/systemd/system/relay.socket',
      ['[Unit]', 'Description=Relay Socket', '[Socket]', 'ListenStream=7777'].join('\n'), 0, 0, 0o644);
    vfsOf(server).writeFile('/etc/systemd/system/relay.service',
      ['[Unit]', 'Description=Relay', '[Service]', 'ExecStart=/usr/bin/relay'].join('\n'), 0, 0, 0o644);
    await server.executeCommand('systemctl daemon-reload');
    return { server, client };
  }

  it('a TCP connection to the socket port starts the service on the server', async () => {
    const { server, client } = await buildLab();
    await server.executeCommand('systemctl start relay.socket');
    expect((await server.executeCommand('systemctl is-active relay')).trim()).toBe('inactive');

    const connected = client.tcpProbeSync(new IPAddress(SERVER_IP), 7777);

    expect(connected).toBe(true);
    expect((await server.executeCommand('systemctl is-active relay')).trim()).toBe('active');
  });

  it('the socket port refuses connections once the socket unit is stopped', async () => {
    const { server, client } = await buildLab();
    await server.executeCommand('systemctl start relay.socket');
    await server.executeCommand('systemctl stop relay.socket');
    await server.executeCommand('systemctl stop relay');

    const connected = client.tcpProbeSync(new IPAddress(SERVER_IP), 7777);

    expect(connected).toBe(false);
    expect((await server.executeCommand('systemctl is-active relay')).trim()).toBe('inactive');
  });

  it('timers ride the machine clock tick', async () => {
    const { server } = await buildLab();
    vfsOf(server).writeFile('/etc/systemd/system/sweep.timer',
      ['[Unit]', '[Timer]', 'OnActiveSec=30', 'Unit=relay.service'].join('\n'), 0, 0, 0o644);
    await server.executeCommand('systemctl daemon-reload');
    const armedAt = new Date();
    await server.executeCommand('systemctl start sweep.timer');

    server.cronTick(new Date(armedAt.getTime() + 60_000));

    expect((await server.executeCommand('systemctl is-active relay')).trim()).toBe('active');
  });
});
