import { waitForEvent } from '@/events/waitForEvent';
import type { HostIcmpEchoFailedPayload, HostIcmpEchoReplyPayload } from './events';
import type { QuotedIcmpErrorWaiter } from './traceHops';

export type EchoOutcome =
  | { kind: 'reply'; r: HostIcmpEchoReplyPayload }
  | { kind: 'failed'; r: HostIcmpEchoFailedPayload };

export interface EchoProbe {
  readonly id: number;
  readonly seq: number;
  readonly target: string;
  readonly anySource: boolean;
}

export function armEchoWait(waiter: QuotedIcmpErrorWaiter, probe: EchoProbe, timeoutMs: number): () => Promise<EchoOutcome> {
  const replied = waitForEvent(
    waiter.bus,
    'host.icmp.echo-reply',
    (p) => p.deviceId === waiter.deviceId && p.id === probe.id && p.seq === probe.seq
      && (probe.anySource || p.fromIp === probe.target),
    { timeoutMs, scheduler: waiter.scheduler },
  ).then((r) => ({ kind: 'reply' as const, r }));
  const failed = waitForEvent(
    waiter.bus,
    'host.icmp.echo-failed',
    (p) => p.deviceId === waiter.deviceId
      && (p.id === -1 || (p.id === probe.id && p.seq === probe.seq))
      && (p.toIp === probe.target || p.toIp === ''),
    { timeoutMs, scheduler: waiter.scheduler },
  ).then((r) => ({ kind: 'failed' as const, r }));
  replied.catch(() => {});
  failed.catch(() => {});
  return () => Promise.race([replied, failed]);
}
