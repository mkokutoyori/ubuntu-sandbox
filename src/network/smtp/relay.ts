import type { TcpStack } from '@/network/tcp/TcpStack';
import type { IEventBus } from '@/events/EventBus';
import { SmtpClientSession } from './SmtpClientSession';

export interface MxTarget {
  readonly preference: number;
  readonly exchange: string;
}

export interface DnsLookup {
  resolveMx(domain: string): Promise<readonly MxTarget[]>;
  resolveAddress(hostname: string): Promise<string | null>;
}

export type RelayTargetKind = MxTarget | { readonly fallbackToAddress: true };

export interface RelayAttempt {
  readonly target: RelayTargetKind;
  readonly outcome: 'delivered' | 'deferred' | 'bounced';
  readonly host?: string;
  readonly detail?: string;
}

export function sortMxByPreference(targets: readonly MxTarget[]): MxTarget[] {
  return [...targets].sort((a, b) => a.preference - b.preference);
}

export function domainOf(address: string): string {
  const at = address.indexOf('@');
  return at === -1 ? '' : address.slice(at + 1);
}

export async function resolveRelayCandidates(
  lookup: DnsLookup, domain: string,
): Promise<readonly { target: RelayTargetKind; hostname: string }[]> {
  const mx = await lookup.resolveMx(domain);
  if (mx.length > 0) {
    return sortMxByPreference(mx).map((t) => ({ target: t, hostname: t.exchange }));
  }
  return [{ target: { fallbackToAddress: true }, hostname: domain }];
}

function reportOutcome(eventBus: IEventBus | undefined, recipient: string, attempt: RelayAttempt): RelayAttempt {
  if (attempt.outcome === 'delivered') eventBus?.publish({ topic: 'smtp.delivery.relayed', payload: { recipient } });
  else if (attempt.outcome === 'deferred') eventBus?.publish({ topic: 'smtp.delivery.deferred', payload: { recipient, reason: attempt.detail ?? '' } });
  else eventBus?.publish({ topic: 'smtp.delivery.bounced', payload: { recipient, reason: attempt.detail ?? '' } });
  return attempt;
}

export async function relayToRecipient(
  tcpStack: TcpStack,
  localIp: string,
  lookup: DnsLookup,
  heloDomain: string,
  envelopeFrom: string,
  recipient: string,
  rawMessage: string,
  eventBus?: IEventBus,
): Promise<RelayAttempt> {
  const domain = domainOf(recipient);
  if (!domain) return reportOutcome(eventBus, recipient, { target: { fallbackToAddress: true }, outcome: 'bounced', detail: 'Recipient has no domain.' });

  const candidates = await resolveRelayCandidates(lookup, domain);
  let lastDetail = 'No MX/A record reachable.';

  for (const candidate of candidates) {
    const ip = await lookup.resolveAddress(candidate.hostname);
    if (!ip) { lastDetail = `Could not resolve ${candidate.hostname}.`; continue; }

    const client = new SmtpClientSession(tcpStack, ip, localIp);
    const banner = client.connect();
    if (!banner || banner.code !== 220) { lastDetail = `Connection to ${candidate.hostname} (${ip}) failed.`; continue; }

    client.sendCommand({ verb: 'EHLO', argument: heloDomain });

    const mail = client.sendCommand({ verb: 'MAIL', argument: `FROM:<${envelopeFrom}>` });
    if (!mail || mail.code >= 500) { client.close(); return reportOutcome(eventBus, recipient, { target: candidate.target, outcome: 'bounced', host: candidate.hostname, detail: mail?.lines.join(' ') }); }
    if (mail.code >= 400) { client.close(); return reportOutcome(eventBus, recipient, { target: candidate.target, outcome: 'deferred', host: candidate.hostname, detail: mail.lines.join(' ') }); }

    const rcpt = client.sendCommand({ verb: 'RCPT', argument: `TO:<${recipient}>` });
    if (!rcpt || rcpt.code >= 500) { client.close(); return reportOutcome(eventBus, recipient, { target: candidate.target, outcome: 'bounced', host: candidate.hostname, detail: rcpt?.lines.join(' ') }); }
    if (rcpt.code >= 400) { client.close(); return reportOutcome(eventBus, recipient, { target: candidate.target, outcome: 'deferred', host: candidate.hostname, detail: rcpt.lines.join(' ') }); }

    const dataReply = client.sendCommand({ verb: 'DATA' });
    if (!dataReply || dataReply.code !== 354) { client.close(); return reportOutcome(eventBus, recipient, { target: candidate.target, outcome: 'deferred', host: candidate.hostname }); }

    const final = client.sendDataBody(rawMessage);
    client.close();
    if (final && final.code >= 200 && final.code < 300) return reportOutcome(eventBus, recipient, { target: candidate.target, outcome: 'delivered', host: candidate.hostname });
    if (final && final.code >= 500) return reportOutcome(eventBus, recipient, { target: candidate.target, outcome: 'bounced', host: candidate.hostname, detail: final.lines.join(' ') });
    return reportOutcome(eventBus, recipient, { target: candidate.target, outcome: 'deferred', host: candidate.hostname });
  }

  return reportOutcome(eventBus, recipient, { target: { fallbackToAddress: true }, outcome: 'deferred', detail: lastDetail });
}
