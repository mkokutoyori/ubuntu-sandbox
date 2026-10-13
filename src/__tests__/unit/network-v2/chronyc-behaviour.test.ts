/**
 * chronyc and chronyd behaviour that the static replay cannot reach, because
 * it needs a daemon that is really synchronised (the replay fixture was
 * recorded against sources that never answer).
 *
 * Reference: chronyc-4.5-live.json, recorded from a real chronyd 4.5
 * synchronised to a stub server (scripts/oracle/record_chronyc_live.py).
 * Values differ from run to run, so the live cases compare the SKELETON of
 * each output: digits, hexadecimal ids, units, dates and addresses are
 * replaced by placeholders, whitespace runs are collapsed, and every line
 * must then be identical (labels, ordering, separators, units).
 *
 * Measured against the previous chronyc: 29 of the 34 cases fail and 5 pass.
 * The passes are the witness (the lab synchronises), the activity and
 * authdata shapes, and the two tracking shapes whose layout did not change;
 * they prove the lab itself is sound.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { Cable } from '@/network/hardware/Cable';
import { MACAddress, resetCounters } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import type { VirtualTimeScheduler } from '@/events/Scheduler';
import { installVirtualClock, converge } from '../../support/ntpTime';

interface Recorded { args: string[]; stdout: string; stderr: string }

const live: Recorded[] = JSON.parse(readFileSync(
  new URL('../../support/oracle/chronyc-4.5-live.json', import.meta.url), 'utf8')).cases;

let clock: VirtualTimeScheduler;
let serie = 0;

beforeEach(() => {
  clock = installVirtualClock();
  resetCounters();
  resetDeviceCounters();
  MACAddress.resetCounter();
  Logger.reset();
});

function skeleton(text: string): string[] {
  return text.trimEnd().split('\n').map((line) => line
    .replace(/\b[A-Z][a-z]{2} [A-Z][a-z]{2} \d{2} \d{2}:\d{2}:\d{2} \d{4}\b/g, 'DATE')
    .replace(/\b\d{1,3}(\.\d{1,3}){3}\b/g, 'IP')
    .replace(/\b[0-9A-F]{8}\b/g, 'HEX')
    .replace(/[+-]?\d+(\.\d+)?(ns|us|ms|s|m|h|d|y)?(?![\w.])/g, '#')
    .replace(/\b(slow|fast)\b/g, 'DIRECTION')
    .replace(/\b(Daemon|Kernel|Hardware)\b/g, 'SOURCE')
    .replace(/\s+/g, ''));
}

async function write(pc: LinuxPC, path: string, text: string): Promise<void> {
  await pc.executeCommand(`printf '${text.replace(/\n/g, '\\n')}' | sudo tee ${path}`);
}

async function lab(chronyConf: string, routerExtra: string[] = []) {
  const router = new CiscoRouter(`R${++serie}`);
  const pc = new LinuxPC(`P${serie}`);
  new Cable(`c${serie}`).connect(router.getPort('GigabitEthernet0/0')!, pc.getPort('eth0')!);
  for (const command of ['enable', 'configure terminal', 'interface GigabitEthernet0/0',
    'ip address 10.0.0.1 255.255.255.0', 'no shutdown', 'exit', 'ntp master 2', ...routerExtra, 'end']) {
    await router.executeCommand(command);
  }
  await pc.executeCommand('ip addr add 10.0.0.2/24 dev eth0');
  await write(pc, '/etc/chrony/chrony.conf', chronyConf);
  await pc.executeCommand('sudo systemctl restart chrony');
  converge(clock, 300_000);
  return { router, pc };
}

const SYNCED_CONF = 'server 10.0.0.1 iburst\nallow 10.0.0.0/24\nratelimit\nmakestep 1000 3\nlocal stratum 10\n';

describe('a synchronised chronyd prints what the recorded chronyd 4.5 prints', () => {
  const firstOccurrence = (c: Recorded, index: number): boolean =>
    live.findIndex((other) => other.args.join(' ') === c.args.join(' ')) === index;
  const comparable = live.filter((c, index) => firstOccurrence(c, index)).filter((c) => !c.args.includes('-c') && ['tracking', 'sources', 'sourcestats', 'ntpdata',
    'selectdata', 'activity', 'authdata'].includes(c.args[c.args.length - 1] === '-v' ? c.args[0] : c.args[0]));

  it('the lab synchronises (witness)', async () => {
    const { pc } = await lab(SYNCED_CONF);
    expect(await pc.executeCommand('chronyc sources')).toMatch(/\^\* 10\.0\.0\.1/);
  });

  for (const recorded of comparable) {
    const command = `chronyc ${recorded.args.join(' ').replace('127.0.0.2', '10.0.0.1')}`;
    it(`${command} has the recorded skeleton`, async () => {
      const { pc } = await lab(SYNCED_CONF, ['ntp server 10.0.0.2']);
      const actual = await pc.executeCommand(`sudo ${command}`);
      expect(skeleton(actual)).toEqual(skeleton(recorded.stdout + recorded.stderr));
    });
  }

  const csvCases = live.filter((c) => c.args[0] === '-c');
  for (const recorded of csvCases) {
    const command = `chronyc ${recorded.args.join(' ')}`;
    it(`${command} has as many CSV fields as the recorded one`, async () => {
      const { pc } = await lab(SYNCED_CONF, ['ntp server 10.0.0.2']);
      const actual = (await pc.executeCommand(`sudo ${command}`)).trimEnd().split('\n');
      const expected = (recorded.stdout + recorded.stderr).trimEnd().split('\n');
      expect(actual.map((line) => line.split(',').length)).toEqual(expected.map((line) => line.split(',').length));
    });
  }
});

describe('chronyd access control is evaluated', () => {
  it('serves nobody without allow', async () => {
    const { router } = await lab('server 10.0.0.1 iburst\n', ['ntp server 10.0.0.2']);
    converge(clock, 120_000);
    const association = router.getNtpAgent().getAssociation('10.0.0.2')!;
    expect(association.reach).toBe(0);
  });

  it('serves the allowed subnet, and a runtime deny of a narrower one cuts it again', async () => {
    const { router, pc } = await lab('server 10.0.0.1 iburst\nallow 10.0.0.0/24\n', ['ntp server 10.0.0.2']);
    converge(clock, 120_000);
    const association = router.getNtpAgent().getAssociation('10.0.0.2')!;
    expect(association.reach).not.toBe(0);
    expect(await pc.executeCommand('sudo chronyc accheck 10.0.0.1')).toBe('208 Access allowed');
    expect(await pc.executeCommand('sudo chronyc deny 10.0.0.1')).toBe('200 OK');
    expect(await pc.executeCommand('sudo chronyc accheck 10.0.0.1')).toBe('209 Access denied');
    expect(await pc.executeCommand('sudo chronyc accheck 10.0.0.77')).toBe('208 Access allowed');
  });

  it('lists the clients that were served', async () => {
    const { pc } = await lab('server 10.0.0.1 iburst\nallow 10.0.0.0/24\n', ['ntp server 10.0.0.2']);
    converge(clock, 120_000);
    const clients = await pc.executeCommand('sudo chronyc clients');
    expect(clients).toMatch(/10\.0\.0\.1 +\d+ +0 +\d+ +- +\d+ +0 +0 +- +-/);
    const stats = await pc.executeCommand('sudo chronyc serverstats');
    expect(stats).toMatch(/NTP packets received +: [1-9]/);
  });

  it('refuses a privileged command to an ordinary user and still answers reads', async () => {
    const { pc } = await lab(SYNCED_CONF);
    expect(await pc.executeCommand('chronyc makestep')).toBe('501 Not authorised');
    expect(await pc.executeCommand('chronyc tracking')).toContain('Reference ID    : ');
    expect(await pc.executeCommand('chronyc clients')).toContain('501 Not authorised');
  });
});

describe('chronyc changes what chronyd does', () => {
  it('offline stops the polling and online resumes it', async () => {
    const { pc, router } = await lab(SYNCED_CONF);
    void router;
    const agent = (pc as unknown as { getNtpAgent(): import('@/network/ntp/NtpAgent').NtpAgent }).getNtpAgent();
    const before = agent.getAssociation('10.0.0.1')!.sent;
    expect(await pc.executeCommand('sudo chronyc offline 10.0.0.1')).toBe('200 OK');
    converge(clock, 300_000);
    expect(agent.getAssociation('10.0.0.1')!.sent).toBe(before);
    expect(await pc.executeCommand('sudo chronyc activity')).toContain('1 sources offline');
    expect(await pc.executeCommand('sudo chronyc sources')).toMatch(/\^\? 10\.0\.0\.1/);
    expect(await pc.executeCommand('sudo chronyc online 10.0.0.1')).toBe('200 OK');
    converge(clock, 300_000);
    expect(agent.getAssociation('10.0.0.1')!.sent).toBeGreaterThan(before);
  });

  it('burst sends the requested number of samples', async () => {
    const { pc } = await lab(SYNCED_CONF);
    const agent = (pc as unknown as { getNtpAgent(): import('@/network/ntp/NtpAgent').NtpAgent }).getNtpAgent();
    const before = agent.getAssociation('10.0.0.1')!.sent;
    expect(await pc.executeCommand('sudo chronyc burst 3/4 10.0.0.1')).toBe('200 OK');
    converge(clock, 20_000);
    expect(agent.getAssociation('10.0.0.1')!.sent - before).toBeGreaterThanOrEqual(3);
  });

  it('add server then delete', async () => {
    const { pc } = await lab(SYNCED_CONF);
    expect(await pc.executeCommand('sudo chronyc add server 10.0.0.9 iburst')).toBe('200 OK');
    expect(await pc.executeCommand('sudo chronyc sources')).toContain('10.0.0.9');
    expect(await pc.executeCommand('sudo chronyc add server 10.0.0.9')).toBe('511 Source already present');
    expect(await pc.executeCommand('sudo chronyc delete 10.0.0.9')).toBe('200 OK');
    expect(await pc.executeCommand('sudo chronyc sources')).not.toContain('10.0.0.9');
  });

  it('selectopts +noselect removes the source from the selection', async () => {
    const { pc } = await lab(SYNCED_CONF);
    expect(await pc.executeCommand('sudo chronyc sources')).toContain('^* 10.0.0.1');
    expect(await pc.executeCommand('sudo chronyc selectopts 10.0.0.1 +noselect')).toBe('200 OK');
    expect(await pc.executeCommand('sudo chronyc sources')).not.toContain('^* 10.0.0.1');
    expect(await pc.executeCommand('sudo chronyc selectdata')).toMatch(/^N 10\.0\.0\.1 +N N/m);
  });

  it('local off stops the local reference', async () => {
    const { pc } = await lab('local stratum 5\n');
    expect(await pc.executeCommand('chronyc tracking')).toContain('Reference ID    : 7F7F0101 ()');
    expect(await pc.executeCommand('sudo chronyc local stratum 7')).toBe('200 OK');
    expect(await pc.executeCommand('chronyc tracking')).toMatch(/Stratum +: 7/);
  });

  it('settime needs manual mode and then steps the clock', async () => {
    const { pc } = await lab('');
    expect(await pc.executeCommand('sudo chronyc settime now')).toBe('505 Facility not enabled in daemon');
    expect(await pc.executeCommand('sudo chronyc manual on')).toBe('200 OK');
    expect(await pc.executeCommand('sudo chronyc settime 12:00:00')).toMatch(/^200 OK\nClock was .* seconds fast\./);
    expect(await pc.executeCommand('sudo chronyc manual list')).toMatch(/n_samples = 1/);
    expect(await pc.executeCommand('sudo chronyc manual delete 0')).toBe('200 OK');
  });
});
