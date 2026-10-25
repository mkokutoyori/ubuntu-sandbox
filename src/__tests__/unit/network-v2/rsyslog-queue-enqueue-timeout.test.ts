/*
 * Probe - src/network/rsyslog/engine/Queue.ts, queue.timeoutEnqueue, ported from runtime/queue.c
 * (doEnqSingleObjContext): a producer that meets a full queue waits timeoutEnqueue ms for room, then the message is
 * discarded and counted; timeoutEnqueue=0 discards at once. The simulator has no producer thread to suspend, so the
 * waiting message is parked in arrival order and each one's deadline starts when it reaches the head of the line,
 * which is what a single blocked reader does.
 * Measured against the previous commit: 3 of the 5 cases fall - the setting was read and never used, so a full queue
 * discarded at once whatever its value (the default 2000 ms and the long 10000 ms both lost messages that a real
 * daemon admits once the consumer frees a slot).
 * The two that pass either way are WITNESSES built in the same lab: timeoutEnqueue=0 discards at once in both states,
 * and an unsaturated queue loses nothing.
 */
import { describe, expect, it, beforeEach } from 'vitest';
import { MACAddress, resetCounters } from '@/network/core/types';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { LabHost, LabNetwork, lines, startRsyslog } from './_helpers/rsyslogLab';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  MACAddress.resetCounter();
  EquipmentRegistry.resetInstance();
  Logger.clear();
});

const TRADITIONAL = '$ActionFileDefaultTemplate RSYSLOG_TraditionalFileFormat\n';

function slowQueue(timeoutEnqueue: string, size = 2): LabHost {
  const host = new LabHost('10.0.0.1', new LabNetwork());
  const setting = timeoutEnqueue === '' ? '' : ` queue.timeoutEnqueue="${timeoutEnqueue}"`;
  startRsyslog(host, `${TRADITIONAL}module(load="imuxsock")\nmodule(load="impstats" interval="3600")\naction(type="omfile" file="/var/log/q.log" name="slow" queue.type="LinkedList" queue.size="${size}" queue.dequeueBatchSize="1" queue.dequeueSlowdown="3000000"${setting})`);
  return host;
}

function burst(host: LabHost, count: number): void {
  for (let n = 1; n <= count; n++) host.logLocal('/run/systemd/journal/syslog', `<13>Oct 19 12:00:00 alice: msg${n}`, { pid: 1, uid: 0, gid: 0 });
}

const written = (host: LabHost): string[] => lines(host.fileSystem.get('/var/log/q.log') ?? null).map((line) => line.replace(/^.*alice: /, ''));

describe('queue.timeoutEnqueue', () => {
  it('witness: timeoutEnqueue=0 discards the messages that find the queue full, at once', () => {
    const host = slowQueue('0');
    burst(host, 5);
    host.advance(60_000);
    expect(written(host)).toEqual(['msg1', 'msg2', 'msg3']);
  });

  it('the default 2000 ms lets a message wait for a slot, loses the one whose wait ran out, and keeps the order', () => {
    const host = slowQueue('');
    burst(host, 5);
    host.advance(60_000);
    expect(written(host)).toEqual(['msg1', 'msg2', 'msg3', 'msg5']);
  });

  it('a wait longer than the consumer slowdown loses nothing', () => {
    const host = slowQueue('10000');
    burst(host, 5);
    host.advance(60_000);
    expect(written(host)).toEqual(['msg1', 'msg2', 'msg3', 'msg4', 'msg5']);
  });

  it('full counts every message that met a full queue, discarded.full only those that gave up', () => {
    const host = new LabHost('10.0.0.1', new LabNetwork());
    startRsyslog(host, `${TRADITIONAL}module(load="imuxsock")\nmodule(load="impstats" interval="60" log.file="/var/log/stats.log")\naction(type="omfile" file="/var/log/q.log" name="slow" queue.type="LinkedList" queue.size="2" queue.dequeueBatchSize="1" queue.dequeueSlowdown="3000000")`);
    burst(host, 5);
    host.advance(60_000);
    const stats = lines(host.fileSystem.get('/var/log/stats.log') ?? null).find((line) => line.includes('slow queue:')) ?? '';
    expect(stats).toMatch(/full=2 discarded\.full=1 /);
  });

  it('witness: a queue that is never saturated loses nothing under any timeout', () => {
    const host = slowQueue('0', 10);
    burst(host, 5);
    host.advance(60_000);
    expect(written(host)).toEqual(['msg1', 'msg2', 'msg3', 'msg4', 'msg5']);
  });
});
