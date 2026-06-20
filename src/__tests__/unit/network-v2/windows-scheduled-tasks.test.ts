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
