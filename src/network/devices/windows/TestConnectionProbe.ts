import type { IPAddress } from '@/network/core/types';
import { PathClock } from '@/network/core/time/PathClock';
import { readIcmpUnreachable } from '@/network/core/icmpUnreachable';
import type { PingProbeAnswer, PingProbeOptions, PingProbeStatus } from '@/powershell/providers/PSProviders';

interface EchoSender {
  sendPingProbeSync(
    target: IPAddress, options?: { ttl?: number; dataSize?: number; df?: boolean },
  ): { success: boolean; rttMs: number; error?: string; localError?: { errno: string } };
}

export function pingAnswerOf(
  reply: { success: boolean; rttMs: number; error?: string; localError?: { errno: string } },
  timeoutSeconds: number | undefined,
): PingProbeAnswer {
  if (reply.success) {
    const late = timeoutSeconds !== undefined && reply.rttMs > timeoutSeconds * 1000;
    return { success: !late, rttMs: reply.rttMs, status: late ? 'TimedOut' : 'Success', replyFrom: null };
  }
  if (reply.localError?.errno === 'EMSGSIZE') return { success: false, rttMs: 0, status: 'PacketTooBig', replyFrom: null };
  const error = reply.error;
  const from = /from ([\d.]+)/.exec(error ?? '')?.[1] ?? null;
  if (error?.includes('Time to live exceeded')) return { success: false, rttMs: 0, status: 'TtlExpired', replyFrom: from };
  const report = readIcmpUnreachable(error);
  if (report === null) return { success: false, rttMs: 0, status: 'TimedOut', replyFrom: null };
  const status: PingProbeStatus = report.code === 4 ? 'PacketTooBig'
    : report.code === 0 ? 'DestinationNetworkUnreachable' : 'DestinationHostUnreachable';
  return { success: false, rttMs: 0, status, replyFrom: report.from || null };
}

export function probeEchoes(sender: EchoSender, target: IPAddress, count: number, options: PingProbeOptions): PingProbeAnswer[] {
  const answers: PingProbeAnswer[] = [];
  for (let sent = 0; sent < Math.max(0, count); sent++) {
    if (sent > 0 && options.delaySeconds !== undefined) PathClock.wait(options.delaySeconds * 1000);
    const reply = sender.sendPingProbeSync(target, { ttl: options.ttl, dataSize: options.bufferSize, df: options.dontFragment });
    answers.push(pingAnswerOf(reply, options.timeoutSeconds));
  }
  return answers;
}

export function pingStatusObject(
  index: number, source: string, destination: string, resolvedIp: string, answer: PingProbeAnswer, bufferSize: number | undefined,
): Record<string, string | number | null> {
  return {
    Ping: index,
    Source: source,
    Destination: destination,
    Address: answer.success ? resolvedIp : answer.replyFrom,
    DisplayAddress: answer.success ? resolvedIp : answer.replyFrom ?? '*',
    Latency: answer.success ? Math.max(1, Math.round(answer.rttMs)) : 0,
    Status: answer.status,
    BufferSize: bufferSize ?? 32,
  };
}
