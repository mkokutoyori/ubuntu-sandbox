/**
 * `date` only knew nine strftime specifiers (`%Y %m %d %H %M %S %s %F
 * %T`) so common format strings like `%a, %b %d` or `%A %p` left the
 * placeholders un-replaced. It also had no `-d` / `--date=`, so a
 * script like `date -d @1716115200` returned the current time and
 * silently dropped the argument. Both gaps are filled here.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { resetCounters, MACAddress } from '@/network/core/types';
import { Logger } from '@/network/core/Logger';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  MACAddress.resetCounter();
  Logger.reset();
});

describe('date — strftime conversions', () => {
  it('parses %a / %A (abbreviated + full weekday)', async () => {
    const pc = new LinuxPC('linux-pc', 'PC1', 0, 0);
    // 2026-05-19 was a Tuesday.
    const out = await pc.executeCommand('date -d "2026-05-19" "+%a %A"');
    expect(out.trim()).toBe('Tue Tuesday');
  });

  it('parses %b / %B / %h (month names)', async () => {
    const pc = new LinuxPC('linux-pc', 'PC1', 0, 0);
    const out = await pc.executeCommand('date -d "2026-05-19" "+%b/%B/%h"');
    expect(out.trim()).toBe('May/May/May');
  });

  it('parses %I %p / %r (12-hour clock)', async () => {
    const pc = new LinuxPC('linux-pc', 'PC1', 0, 0);
    const out = await pc.executeCommand('date -d "2026-05-19T15:04:05" "+%I:%M %p"');
    expect(out.trim()).toBe('03:04 PM');
    const r = await pc.executeCommand('date -d "2026-05-19T01:02:03" "+%r"');
    expect(r.trim()).toBe('01:02:03 AM');
  });

  it('parses %j (day of year)', async () => {
    const pc = new LinuxPC('linux-pc', 'PC1', 0, 0);
    const out = await pc.executeCommand('date -d "2026-02-01" "+%j"');
    expect(out.trim()).toBe('032');
  });

  it('parses %D (US short date)', async () => {
    const pc = new LinuxPC('linux-pc', 'PC1', 0, 0);
    const out = await pc.executeCommand('date -d "2026-05-19" "+%D"');
    expect(out.trim()).toBe('05/19/26');
  });

  it('parses %R (24-hour HH:MM)', async () => {
    const pc = new LinuxPC('linux-pc', 'PC1', 0, 0);
    const out = await pc.executeCommand('date -d "2026-05-19T15:04:05" "+%R"');
    expect(out.trim()).toBe('15:04');
  });

  it('parses %u (Monday-1 week index)', async () => {
    const pc = new LinuxPC('linux-pc', 'PC1', 0, 0);
    // Sunday → 7, Monday → 1.
    const sun = await pc.executeCommand('date -d "2026-05-17" "+%u"');
    const mon = await pc.executeCommand('date -d "2026-05-18" "+%u"');
    expect(sun.trim()).toBe('7');
    expect(mon.trim()).toBe('1');
  });

  it('preserves literal text between specifiers', async () => {
    const pc = new LinuxPC('linux-pc', 'PC1', 0, 0);
    const out = await pc.executeCommand('date -d "2026-05-19T15:04:05" "+today is %A at %H hours"');
    expect(out.trim()).toBe('today is Tuesday at 15 hours');
  });

  it('leaves unknown specifiers untouched (graceful degradation)', async () => {
    const pc = new LinuxPC('linux-pc', 'PC1', 0, 0);
    const out = await pc.executeCommand('date -d "2026-05-19" "+%Q-%Y"');
    expect(out.trim()).toBe('%Q-2026');
  });
});

describe('date — -d / --date= input parsing', () => {
  it('@<seconds> reads a unix timestamp', async () => {
    const pc = new LinuxPC('linux-pc', 'PC1', 0, 0);
    // 1_716_115_200 → 2024-05-19 10:40:00 UTC
    const out = await pc.executeCommand('date -d @1716115200 "+%F %T"');
    expect(out.trim()).toBe('2024-05-19 10:40:00');
  });

  it('--date= equals form is accepted', async () => {
    const pc = new LinuxPC('linux-pc', 'PC1', 0, 0);
    const out = await pc.executeCommand('date --date=2026-01-01 "+%Y"');
    expect(out.trim()).toBe('2026');
  });

  it('yesterday / today / tomorrow are relative anchors', async () => {
    const pc = new LinuxPC('linux-pc', 'PC1', 0, 0);
    const today = (await pc.executeCommand('date -d today "+%s"')).trim();
    const tomorrow = (await pc.executeCommand('date -d tomorrow "+%s"')).trim();
    const yesterday = (await pc.executeCommand('date -d yesterday "+%s"')).trim();
    expect(parseInt(tomorrow, 10) - parseInt(today, 10)).toBe(86_400);
    expect(parseInt(today, 10) - parseInt(yesterday, 10)).toBe(86_400);
  });

  it('rejects garbage with the coreutils error string', async () => {
    const pc = new LinuxPC('linux-pc', 'PC1', 0, 0);
    const out = await pc.executeCommand('date -d "not a date" "+%F"');
    expect(out).toMatch(/^date: invalid date 'not a date'/);
  });
});
