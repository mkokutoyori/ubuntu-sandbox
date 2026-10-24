/**
 * Probe — queue.saveOnShutdown with queue.fileName (runtime/queue.c qqueueSaveOnShutdown / qqueueStart): the messages a
 * queue still holds when the daemon stops are saved in WorkDirectory/<fileName>.qi and delivered after the next start.
 * The state is the object stream of the source (runtime/obj.c, stream.c, msg.c): a queue info file <fileName>.qi and the
 * numbered data file <fileName>.00000001, no longer one JSON document.
 *
 * Measured against the preceding commit (git stash of src/network): 2 of the 4 cases fall (the saved state was a JSON
 * document, so the stream records are absent). The 2 that pass in both states are the WITNESS (a queue without a file
 * name keeps nothing across a restart) and saveOnShutdown="off", which also keeps nothing.
 */
import { describe, expect, it } from 'vitest';
import { LabHost, LabNetwork, lines, startRsyslog, submitLocal } from './_helpers/rsyslogLab';

const MSG = (text: string): string => `<13>Oct 19 12:00:01 ubuntu alice: ${text}`;
const TEMPLATE = 'template(name="probe" type="string" string="%msg%\\n")\nglobal(workDirectory="/var/spool/rsyslog")\n';
const stuck = (queue: string): string =>
  `${TEMPLATE}action(type="omfile" name="out" file="/no/such/x.log" createDirs="off" template="probe" action.resumeRetryCount="-1" action.resumeInterval="30" queue.type="LinkedList" ${queue})\n`;
const healthy = (queue: string): string =>
  `${TEMPLATE}action(type="omfile" name="out" file="/var/log/x.log" template="probe" action.resumeRetryCount="-1" queue.type="LinkedList" ${queue})\n`;
const written = (host: LabHost): string[] => lines(host.fileSystem.get('/var/log/x.log') ?? null).map((line) => line.trim());

describe('queue state across a restart', () => {
  function stopWithBacklog(queue: string): LabHost {
    const host = new LabHost('10.0.0.1', new LabNetwork());
    host.directories.add('/var/spool/rsyslog');
    const lab = startRsyslog(host, stuck(queue));
    for (const text of ['one', 'two', 'three']) submitLocal(lab, MSG(text));
    lab.engine.stop();
    return host;
  }

  it('witness: a queue without a file name keeps nothing', () => {
    const host = stopWithBacklog('');
    startRsyslog(host, healthy(''));
    host.advance(5_000);
    expect(written(host)).toEqual([]);
  });

  it('saves what the queue holds at stop and delivers it after the next start', () => {
    const host = stopWithBacklog('queue.filename="outq" queue.diskQueueType="disk" queue.saveOnShutdown="on"');
    expect(host.fileSystem.get('/var/spool/rsyslog/outq.qi')).toContain('<OPB:1:qqueue:1:\n+iQueueSize:2:1:3:\n');
    expect(host.fileSystem.get('/var/spool/rsyslog/outq.00000001')).toContain('<Obj:1:msg:1:\n');
    expect(host.fileSystem.get('/var/spool/rsyslog/outq.00000001')).toContain('+pszRawMsg:1:');
    startRsyslog(host, healthy('queue.filename="outq" queue.diskQueueType="disk" queue.saveOnShutdown="on"'));
    host.advance(5_000);
    expect(written(host)).toEqual(['one', 'two', 'three']);
  });

  it('saveOnShutdown off drops the backlog', () => {
    const host = stopWithBacklog('queue.filename="outq" queue.diskQueueType="disk" queue.saveOnShutdown="off"');
    expect(host.fileSystem.has('/var/spool/rsyslog/outq.qi')).toBe(false);
    startRsyslog(host, healthy('queue.filename="outq" queue.diskQueueType="disk" queue.saveOnShutdown="off"'));
    host.advance(5_000);
    expect(written(host)).toEqual([]);
  });

  it('does not deliver the same backlog twice after a second restart', () => {
    const host = stopWithBacklog('queue.filename="outq" queue.diskQueueType="disk" queue.saveOnShutdown="on"');
    const second = startRsyslog(host, healthy('queue.filename="outq" queue.diskQueueType="disk" queue.saveOnShutdown="on"'));
    host.advance(5_000);
    second.engine.stop();
    startRsyslog(host, healthy('queue.filename="outq" queue.diskQueueType="disk" queue.saveOnShutdown="on"'));
    host.advance(5_000);
    expect(written(host)).toEqual(['one', 'two', 'three']);
  });
});
