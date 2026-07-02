import { describe, it, expect, beforeEach } from 'vitest';
import { WindowsPC } from '@/network/devices/WindowsPC';
import { resetCounters } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';

function pc(): WindowsPC {
  const p = new WindowsPC('windows-pc', 'WIN-SCH');
  p.setCurrentUser('Administrator');
  return p;
}

describe('schtasks — scheduled tasks fire on the simulated clock', () => {
  let win: WindowsPC;
  beforeEach(() => {
    resetCounters();
    resetDeviceCounters();
    win = pc();
  });

  it('a one-time task runs its program only once the clock reaches /ST', async () => {
    await win.executeCmdCommand('schtasks /create /tn FireOnce /sc once /st 00:01 /tr C:\\Windows\\fireonce.exe');
    expect(await win.executeCmdCommand('tasklist')).not.toContain('fireonce.exe');

    win.advanceTime(30_000);
    expect(await win.executeCmdCommand('tasklist')).not.toContain('fireonce.exe');

    win.advanceTime(40_000); // 70s past midnight; /ST 00:01 == 60s
    expect(await win.executeCmdCommand('tasklist')).toContain('fireonce.exe');
  });

  it('a fired one-time task does not run twice', async () => {
    await win.executeCmdCommand('schtasks /create /tn Twice /sc once /st 00:01 /tr C:\\app\\twice.exe');
    win.advanceTime(120_000);
    const first = (await win.executeCmdCommand('tasklist')).split('twice.exe').length - 1;
    win.advanceTime(120_000);
    const second = (await win.executeCmdCommand('tasklist')).split('twice.exe').length - 1;
    expect(first).toBe(1);
    expect(second).toBe(1);
  });

  it('schtasks /run executes the task immediately', async () => {
    await win.executeCmdCommand('schtasks /create /tn RunNow /sc once /st 23:59 /tr C:\\tools\\runnow.exe');
    expect(await win.executeCmdCommand('tasklist')).not.toContain('runnow.exe');
    await win.executeCmdCommand('schtasks /run /tn RunNow');
    expect(await win.executeCmdCommand('tasklist')).toContain('runnow.exe');
  });

  it('tasks do not fire while the Schedule service is stopped', async () => {
    await win.executeCmdCommand('schtasks /create /tn NoSched /sc once /st 00:01 /tr C:\\x\\nosched.exe');
    await win.executeCmdCommand('net stop Schedule');
    win.advanceTime(120_000);
    expect(await win.executeCmdCommand('tasklist')).not.toContain('nosched.exe');
  });
});

function count(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

describe('schtasks — recurring tasks re-arm on the simulated clock', () => {
  let win: WindowsPC;
  beforeEach(() => {
    resetCounters();
    resetDeviceCounters();
    win = pc();
  });

  it('a /SC MINUTE task fires every minute', async () => {
    await win.executeCmdCommand('schtasks /create /tn Min /sc minute /tr C:\\m\\min.exe');
    win.advanceTime(3 * 60_000);
    expect(count(await win.executeCmdCommand('tasklist'), 'min.exe')).toBe(3);
  });

  it('a /SC MINUTE /MO 2 task fires every two minutes', async () => {
    await win.executeCmdCommand('schtasks /create /tn Min2 /sc minute /mo 2 /tr C:\\m\\min2.exe');
    win.advanceTime(4 * 60_000);
    expect(count(await win.executeCmdCommand('tasklist'), 'min2.exe')).toBe(2);
  });

  it('a /SC DAILY task fires once per day at its start time', async () => {
    await win.executeCmdCommand('schtasks /create /tn Daily /sc daily /st 12:00 /tr C:\\d\\daily.exe');
    win.advanceTime(13 * 60 * 60_000); // 13h: past day-0 12:00
    expect(count(await win.executeCmdCommand('tasklist'), 'daily.exe')).toBe(1);
    win.advanceTime(24 * 60 * 60_000); // 37h: past day-1 12:00
    expect(count(await win.executeCmdCommand('tasklist'), 'daily.exe')).toBe(2);
  });

  it('a recurring task stops firing once Schedule is stopped', async () => {
    await win.executeCmdCommand('schtasks /create /tn MinStop /sc minute /tr C:\\m\\minstop.exe');
    win.advanceTime(60_000);
    const after1 = count(await win.executeCmdCommand('tasklist'), 'minstop.exe');
    await win.executeCmdCommand('net stop Schedule');
    win.advanceTime(5 * 60_000);
    expect(count(await win.executeCmdCommand('tasklist'), 'minstop.exe')).toBe(after1);
  });
});
