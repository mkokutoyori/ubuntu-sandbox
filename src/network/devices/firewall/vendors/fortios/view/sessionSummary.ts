import { protocolKeywordFor } from '../../../../router/acl/AclSyntax';
import type { FirewallSession } from '../../../session/SessionTable';
import type { SessionTtlTable } from '../../../session/SessionTtlTable';
import { originalFlow } from '../diag/sessionListRenderer';

const NONE = '-';

const HEADER = 'PROTO     EXPIRE  SOURCE         SOURCE-NAT'
  + '   DESTINATION    DESTINATION-NAT';

function endpoint(address: string, port: number): string {
  return `${address}:${port}`;
}

function sourceNat(session: FirewallSession): string {
  const translation = session.translation;
  if (!translation) return NONE;
  if (translation.translatedSource === translation.originalSource
    && translation.translatedSourcePort === translation.originalSourcePort) return NONE;
  return endpoint(translation.translatedSource, translation.translatedSourcePort);
}

function destinationNat(session: FirewallSession): string {
  const translation = session.translation;
  if (!translation) return NONE;
  if (translation.translatedDest === translation.originalDest
    && translation.translatedDestPort === translation.originalDestPort) return NONE;
  return endpoint(translation.translatedDest, translation.translatedDestPort);
}

export function renderSessionSummary(
  sessions: readonly FirewallSession[], now: number,
): string {
  const lines = [HEADER];

  for (const session of sessions) {
    const flow = originalFlow(session);
    const expire = Math.max(0, Math.floor((session.expiresAt - now) / 1000));
    lines.push([
      protocolKeywordFor(flow.protocol),
      String(expire),
      endpoint(flow.sourceIP, flow.sourcePort),
      sourceNat(session),
      endpoint(flow.destIP, flow.destPort),
      destinationNat(session),
    ].join(' '));
  }

  return lines.join('\n');
}

export function renderSessionCount(count: number): string {
  return `The total number of sessions for the current VDOM: ${count}`;
}

export function renderSessionTtl(ttl: SessionTtlTable): string {
  const lines = ['session timeout:', `Default timeout=${ttl.getDefault()}`];
  for (const entry of ttl.list()) {
    lines.push(`id=${entry.id} protocol=${entry.protocol}`
      + ` port=${entry.startPort}-${entry.endPort} timeout=${entry.timeoutSec}`);
  }
  return lines.join('\n');
}
