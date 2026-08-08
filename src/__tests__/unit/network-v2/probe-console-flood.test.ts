import { describe, it, expect, beforeEach } from 'vitest';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { Cable } from '@/network/hardware/Cable';
import { LoggingConfig } from '@/network/devices/inspection/config/LoggingConfig';
import { formatIosUptime } from '@/network/devices/shells/cisco/CiscoCommonShow';
import { MACAddress, resetCounters } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  MACAddress.resetCounter();
  Logger.reset();
});

describe('a down interface counts, it does not narrate', () => {
  it('a frame reaching a down port produces no console line at all', async () => {
    const r = new CiscoRouter('Router1');
    const pc = new LinuxPC('linux-pc', 'PC', 0, 0);
    new Cable('c').connect(r.getPort('GigabitEthernet0/0')!, pc.getPort('eth0')!);
    await r.executeCommand('enable');

    const port = r.getPort('GigabitEthernet0/0')!;
    const logging = (r as unknown as { _loggingConfig?: LoggingConfig })._loggingConfig;
    const seen: string[] = [];
    logging?.subscribeConsole((l) => seen.push(l));

    await r.executeCommand('configure terminal');
    await r.executeCommand('interface GigabitEthernet0/0');
    await r.executeCommand('shutdown');
    await r.executeCommand('end');
    seen.length = 0;

    const frame = {
      srcMAC: new MACAddress('AA:BB:CC:DD:EE:FF'),
      dstMAC: new MACAddress('FF:FF:FF:FF:FF:FF'),
      etherType: 0x0800,
      payload: null,
    } as unknown as Parameters<typeof port.receiveFrame>[0];
    for (let i = 0; i < 50; i++) port.receiveFrame(frame);

    expect(seen).toEqual([]);
    expect(seen.join('\n')).not.toContain('PORT-4');
  });

  it('but it COUNTS them, which is what show interfaces reports', async () => {
    const r = new CiscoRouter('Router1');
    const pc = new LinuxPC('linux-pc', 'PC', 0, 0);
    new Cable('c').connect(r.getPort('GigabitEthernet0/0')!, pc.getPort('eth0')!);
    await r.executeCommand('enable');
    await r.executeCommand('configure terminal');
    await r.executeCommand('interface GigabitEthernet0/0');
    await r.executeCommand('shutdown');
    await r.executeCommand('end');

    const port = r.getPort('GigabitEthernet0/0')!;
    const before = port.getCounters().dropsIn;
    const frame = {
      srcMAC: new MACAddress('AA:BB:CC:DD:EE:FF'),
      dstMAC: new MACAddress('FF:FF:FF:FF:FF:FF'),
      etherType: 0x0800,
      payload: null,
    } as unknown as Parameters<typeof port.receiveFrame>[0];
    for (let i = 0; i < 7; i++) port.receiveFrame(frame);

    expect(port.getCounters().dropsIn).toBe(before + 7);
    expect(await r.executeCommand('show interfaces GigabitEthernet0/0'))
      .toMatch(/input drops/);
  });

  it('no fabricated %PORT facility survives anywhere', async () => {
    const r = new CiscoRouter('Router1');
    const pc = new LinuxPC('linux-pc', 'PC', 0, 0);
    new Cable('c').connect(r.getPort('GigabitEthernet0/0')!, pc.getPort('eth0')!);
    await r.executeCommand('enable');
    await r.executeCommand('configure terminal');
    await r.executeCommand('interface GigabitEthernet0/0');
    await r.executeCommand('shutdown');
    await r.executeCommand('end');

    const port = r.getPort('GigabitEthernet0/0')!;
    const frame = {
      srcMAC: new MACAddress('AA:BB:CC:DD:EE:FF'),
      dstMAC: new MACAddress('FF:FF:FF:FF:FF:FF'),
      etherType: 0x0800,
      payload: null,
    } as unknown as Parameters<typeof port.receiveFrame>[0];
    for (let i = 0; i < 20; i++) port.receiveFrame(frame);

    expect(await r.executeCommand('show logging')).not.toContain('PORT-4');
  });
});

describe('logging rate-limit really limits', () => {
  function configured(limit: number | null): { cfg: LoggingConfig; lines: string[] } {
    const cfg = new LoggingConfig();
    const lines: string[] = [];
    cfg.subscribeConsole((l) => lines.push(l));
    if (limit !== null) cfg.apply(['rate-limit', String(limit)], false);
    return { cfg, lines };
  }

  it('caps the console at N messages per second', () => {
    const { cfg, lines } = configured(3);
    for (let i = 0; i < 40; i++) cfg.append('warnings', 'sys', `burst ${i}`, true, 'CONFIG_I');
    expect(lines.filter((l) => l.includes('burst')).length).toBe(3);
  });

  it('says how many it suppressed rather than dropping them silently', () => {
    const { cfg, lines } = configured(2);
    const realNow = Date.now;
    try {
      const base = realNow();
      Date.now = () => base;
      for (let i = 0; i < 10; i++) cfg.append('warnings', 'sys', `burst ${i}`, true, 'CONFIG_I');
      lines.length = 0;
      // Une seconde plus tard, la premiere ligne qui passe porte le compte.
      Date.now = () => base + 2000;
      cfg.append('warnings', 'sys', 'apres', true, 'CONFIG_I');
    } finally {
      Date.now = realNow;
    }
    expect(lines.join('\n')).toMatch(/%LOGGING-4-RATELIMIT: 8 messages rate-limited/);
  });

  it('with no rate-limit configured, nothing is dropped', () => {
    const { cfg, lines } = configured(null);
    for (let i = 0; i < 40; i++) cfg.append('warnings', 'sys', `burst ${i}`, true, 'CONFIG_I');
    expect(lines.filter((l) => l.includes('burst')).length).toBe(40);
  });

  it('the buffer keeps every message, limited or not', () => {
    const { cfg } = configured(2);
    cfg.apply(['buffered'], false);
    for (let i = 0; i < 20; i++) cfg.append('warnings', 'sys', `burst ${i}`, true, 'CONFIG_I');
    expect(cfg.render().split('\n').filter((l) => l.includes('burst')).length)
      .toBeGreaterThan(2);
  });
});

describe('uptime is written the way IOS writes it', () => {
  // La seconde n'est PAS une unité de cette ligne. Le constructeur
  // d'uptime d'IOS ne connaît que semaines, jours, heures et minutes,
  // donc un routeur démarré depuis vingt secondes écrit « 0 minutes » —
  // ce qui a l'air étrange et qui est ce qu'il écrit. Afficher des
  // secondes trahissait un compteur interne qu'IOS n'expose pas ici.
  it.each([
    [0, '0 minutes'],
    [1_000, '0 minutes'],
    [12_000, '0 minutes'],
    [59_000, '0 minutes'],
    [60_000, '1 minute'],
    [180_000, '3 minutes'],
    [3_840_000, '1 hour, 4 minutes'],
    [7_200_000, '2 hours'],
    [86_400_000, '1 day'],
    [1_490_000_000, '2 weeks, 3 days, 5 hours, 53 minutes'],
  ])('%ims reads as %s', (ms, expected) => {
    expect(formatIosUptime(ms)).toBe(expected);
  });

  it('show version compte en minutes, jamais en secondes', async () => {
    const r = new CiscoRouter('Router1');
    await r.executeCommand('enable');
    const out = await r.executeCommand('show version');
    expect(out).toMatch(/uptime is \d+ (minute|hour|day|week)/);
    expect(out).not.toMatch(/uptime is \d+ seconds?/);
  });
});
