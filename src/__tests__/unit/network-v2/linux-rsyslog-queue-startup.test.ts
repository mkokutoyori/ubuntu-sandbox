/**
 * Probe — global(abortOnFailedQueueStartup) of rsyslog 8.2610 (runtime/action.c actionStartQueue, tools/rsyslogd.c
 * startMainQueue). A disk queue declared with the legacy directives ($ActionQueueType Disk, $MainMsgQueueType Disk) and
 * no queue.fileName cannot start (RS_RET_FILE_PREFIX_MISSING, runtime/stream.c strmSetFName): the daemon says so,
 * disables that action and goes on with the others. The same queue declared with queue.* parameters never gets that far:
 * qqueueApplyCnfParam reports it at load time and turns the queue into a linkedList (last two cases). With
 * abortOnFailedQueueStartup="on" it writes one line to stderr and exits instead, without the "run failed" line that a
 * configuration error produces. The main message queue has the same rule with its own wording; without the parameter the
 * source falls back to a direct queue, which is what the engine's synchronous queue already is.
 * Measured against the preceding commit (git stash of src/network): 3 of the 5 cases fall - the disk queue without a file
 * name was accepted, the action wrote, nothing was logged, and the parameter was never read. The 2 that pass either way
 * are WITNESSES from the same lab: a disk queue with a file name writes its message, with and without the parameter.
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

async function configured(config: string): Promise<LinuxServer> {
  const host = new LinuxServer('linux-server', 'host1', 0, 0);
  host.powerOn();
  await host.executeCommand(`printf '${config.replace(/'/g, "'\\''")}\\n' > /etc/rsyslog.d/40-test.conf`);
  await host.executeCommand('systemctl restart rsyslog');
  await host.executeCommand('logger -p local4.info -t probe the-message');
  return host;
}

const WITHOUT_NAME = '$ActionQueueType Disk\nlocal4.* /var/log/queued.log\nlocal4.* /var/log/plain.log';

describe('a disk queue that cannot start', () => {
  it('witness: with a file name the disk queue starts and the message is written', async () => {
    const host = await configured('local4.* action(type="omfile" file="/var/log/queued.log" queue.type="Disk" queue.filename="q1")');
    expect(await host.executeCommand('cat /var/log/queued.log')).toContain('probe: the-message');
  }, 60_000);

  it('is reported and its action is disabled while the others go on', async () => {
    const host = await configured(WITHOUT_NAME);
    const syslog = await host.executeCommand('cat /var/log/syslog');
    expect(syslog).toContain('error starting up action queue');
    expect(syslog).toContain('file prefix (work directory?) is missing');
    expect(await host.executeCommand('cat /var/log/queued.log 2>&1')).not.toContain('probe: the-message');
    expect(await host.executeCommand('cat /var/log/plain.log')).toContain('probe: the-message');
  }, 60_000);

  it('abortOnFailedQueueStartup stops the daemon with the line of the source', async () => {
    const host = await configured(`global(abortOnFailedQueueStartup="on")\n${WITHOUT_NAME}`);
    expect(await host.executeCommand('systemctl is-active rsyslog')).not.toContain('active\n');
    const syslog = await host.executeCommand('journalctl -u rsyslog --no-pager 2>&1');
    expect(syslog).toContain('error -2036 starting up action queue, abortOnFailedQueueStartup is set, so we abort rsyslog now.');
    expect(syslog).not.toContain('run failed with error');
  }, 60_000);

  it('the main message queue says so in its own words, and aborts only on request', async () => {
    const host = await configured('$MainMsgQueueType Disk\nlocal4.* /var/log/plain.log');
    expect(await host.executeCommand('cat /var/log/syslog')).toContain('could not start (ruleset) main message queue');
    expect(await host.executeCommand('cat /var/log/plain.log')).toContain('probe: the-message');
    const aborted = await configured('global(abortOnFailedQueueStartup="on")\n$MainMsgQueueType Disk\nlocal4.* /var/log/plain.log');
    expect(await aborted.executeCommand('journalctl -u rsyslog --no-pager 2>&1')).toContain('could not start (ruleset) main message queue, local queue safety or abortOnFailedQueueStartup requires aborting rsyslog now.');
  }, 60_000);

  it('an action queue that starts is unaffected by the parameter', async () => {
    const host = await configured('global(abortOnFailedQueueStartup="on")\nlocal4.* action(type="omfile" file="/var/log/queued.log" queue.type="Disk" queue.filename="q1")');
    expect(await host.executeCommand('cat /var/log/queued.log')).toContain('probe: the-message');
    expect(await host.executeCommand('systemctl is-active rsyslog')).toContain('active');
  }, 60_000);

  it('declared with queue.* parameters it is refused at load time and runs as a linkedList', async () => {
    const host = await configured('local4.* action(type="omfile" file="/var/log/queued.log" queue.type="Disk")');
    const check = await host.executeCommand('rsyslogd -N1 -f /etc/rsyslog.conf 2>&1');
    expect(check).toMatch(/error on queue 'action-\d+-builtin:omfile queue', disk mode selected, but no queue file name given; queue type changed to 'linkedList'/);
    expect(await host.executeCommand('cat /var/log/queued.log')).toContain('probe: the-message');
  }, 60_000);

  it('abortOnFailedQueueStartup has nothing to abort for it', async () => {
    const host = await configured('global(abortOnFailedQueueStartup="on")\nlocal4.* action(type="omfile" file="/var/log/queued.log" queue.type="Disk")');
    expect(await host.executeCommand('systemctl is-active rsyslog')).toContain('active');
    expect(await host.executeCommand('cat /var/log/queued.log')).toContain('probe: the-message');
  }, 60_000);
});
