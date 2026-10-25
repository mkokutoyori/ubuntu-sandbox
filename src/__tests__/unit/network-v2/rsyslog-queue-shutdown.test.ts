/*
 * Probe - src/network/rsyslog/engine/Queue.ts and Engine.ts, queue.timeoutShutdown, queue.timeoutActionCompletion,
 * default.action.queue.* / default.ruleset.queue.* and shutdown.queue.doubleSize, ported from runtime/queue.c
 * (qqueueDestruct, qqueueShutdownWorkers) and runtime/glbl.c. At stop the worker of each queue keeps running for
 * timeoutShutdown ms (1500 for the main and ruleset queues, 10 for an action queue) before it is cancelled; the
 * simulator has no thread to cancel, so the wait is spent by firing the worker's own pending wake-ups (dequeue
 * slowdown, requeue pace) while the budget lasts. shutdown.queue.doubleSize doubles the capacity of every queue
 * before that drain, so a main queue that forwards its backlog into a small action queue loses less.
 * Measured against the previous commit: 6 of the 9 cases fall - every queue was stopped at once whatever its
 * timeout, the default.*.queue.* globals were accepted and ignored, and doubleSize did nothing.
 * The three that pass either way are WITNESSES built in the same lab: timeoutShutdown=0 and the 10 ms action default
 * keep only the message that was already processed at stop, and an explicit queue.timeoutShutdown on the action wins
 * over the global default.
 */
import { describe, expect, it, beforeEach } from 'vitest';
import { MACAddress, resetCounters } from '@/network/core/types';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { LabHost, LabNetwork, lines, startRsyslog, type LabEngine } from './_helpers/rsyslogLab';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  MACAddress.resetCounter();
  EquipmentRegistry.resetInstance();
  Logger.clear();
});

const TRADITIONAL = '$ActionFileDefaultTemplate RSYSLOG_TraditionalFileFormat\n';

function start(config: string): LabEngine {
  return startRsyslog(new LabHost('10.0.0.1', new LabNetwork()), `${TRADITIONAL}module(load="imuxsock")\n${config}`);
}

function burst(lab: LabEngine, count: number): void {
  for (let n = 1; n <= count; n++) lab.host.logLocal('/run/systemd/journal/syslog', `<13>Oct 19 12:00:00 alice: msg${n}`, { pid: 1, uid: 0, gid: 0 });
}

const written = (lab: LabEngine): string[] => lines(lab.host.fileSystem.get('/var/log/q.log') ?? null).map((line) => line.replace(/^.*alice: /, ''));

const SLOW = 'queue.type="LinkedList" queue.size="10" queue.dequeueBatchSize="1" queue.dequeueSlowdown="400000" queue.saveOnShutdown="off"';

describe('queue.timeoutShutdown', () => {
  it('witness: timeoutShutdown=0 keeps only what was processed before the stop', () => {
    const lab = start(`action(type="omfile" file="/var/log/q.log" ${SLOW} queue.timeoutShutdown="0")`);
    burst(lab, 5);
    lab.engine.stop();
    expect(written(lab)).toEqual(['msg1']);
  });

  it('the worker keeps running for the timeout: two more slowed-down batches fit in 1000 ms', () => {
    const lab = start(`action(type="omfile" file="/var/log/q.log" ${SLOW} queue.timeoutShutdown="1000")`);
    burst(lab, 5);
    lab.engine.stop();
    expect(written(lab)).toEqual(['msg1', 'msg2', 'msg3']);
  });

  it('an action queue defaults to 10 ms, too short for a 400 ms slowdown', () => {
    const lab = start(`action(type="omfile" file="/var/log/q.log" ${SLOW})`);
    burst(lab, 5);
    lab.engine.stop();
    expect(written(lab)).toEqual(['msg1']);
  });

  it('a main queue defaults to 1500 ms and drains three more batches', () => {
    const lab = start(`main_queue(queue.type="LinkedList" queue.size="100" queue.dequeueBatchSize="1" queue.dequeueSlowdown="400000" queue.saveOnShutdown="off")\n*.* /var/log/q.log`);
    burst(lab, 6);
    lab.engine.stop();
    expect(written(lab)).toEqual(['msg1', 'msg2', 'msg3', 'msg4']);
  });
});

describe('default.action.queue.* and default.ruleset.queue.*', () => {
  it('the global default reaches an action that sets no timeout of its own', () => {
    const lab = start(`global(default.action.queue.timeoutshutdown="1000")\naction(type="omfile" file="/var/log/q.log" ${SLOW})`);
    burst(lab, 5);
    lab.engine.stop();
    expect(written(lab)).toEqual(['msg1', 'msg2', 'msg3']);
  });

  it('witness: an explicit queue.timeoutShutdown on the action wins over the global default', () => {
    const lab = start(`global(default.action.queue.timeoutshutdown="1000")\naction(type="omfile" file="/var/log/q.log" ${SLOW} queue.timeoutShutdown="0")`);
    burst(lab, 5);
    lab.engine.stop();
    expect(written(lab)).toEqual(['msg1']);
  });

  it('the legacy $ActionQueueTimeoutShutdown directive and the global default combine the same way', () => {
    const lab = start(`global(default.action.queue.timeoutshutdown="1000")\n$ActionQueueType LinkedList\n$ActionQueueSize 10\n$ActionQueueDequeueBatchSize 1\n$ActionQueueDequeueSlowdown 400000\n$ActionQueueSaveOnShutdown off\n*.* /var/log/q.log`);
    burst(lab, 5);
    lab.engine.stop();
    expect(written(lab)).toEqual(['msg1', 'msg2', 'msg3']);
  });
});

describe('shutdown.queue.doubleSize', () => {
  const forwarding = (global: string): LabEngine => start(`${global}main_queue(queue.type="LinkedList" queue.size="100" queue.dequeueBatchSize="1" queue.dequeueSlowdown="100000" queue.timeoutShutdown="5000" queue.saveOnShutdown="off")\naction(type="omfile" file="/var/log/q.log" queue.type="LinkedList" queue.size="2" queue.dequeueBatchSize="1" queue.dequeueSlowdown="1000000" queue.timeoutEnqueue="0" queue.timeoutShutdown="5000" queue.saveOnShutdown="off")`);

  it('doubles the capacity every queue has while the backlog is forwarded at shutdown', () => {
    const lab = forwarding('global(shutdown.queue.doubleSize="on")\n');
    burst(lab, 8);
    lab.engine.stop();
    expect(written(lab)).toHaveLength(5);
  });

  it('without it the same lab keeps the configured size and loses the rest', () => {
    const lab = forwarding('');
    burst(lab, 8);
    lab.engine.stop();
    expect(written(lab)).toHaveLength(3);
  });
});
