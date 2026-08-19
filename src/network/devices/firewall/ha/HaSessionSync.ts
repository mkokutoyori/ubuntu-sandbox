import { makeFlowKey, type FlowKey } from '../session/FlowKey';
import type { SessionTable } from '../session/SessionTable';
import type { HaSyncedSession } from './HaTypes';

export function exportSessions(table: SessionTable): readonly HaSyncedSession[] {
  return table.view().all().map(session => ({
    key: keyText(session.c2s),
    ingressZone: session.ingressZone,
    egressZone: session.egressZone,
    ingressInterface: session.ingressInterface,
    egressInterface: session.egressInterface,
    timeoutSec: session.timeoutSec,
    policyId: session.policyId,
  }));
}

export function importSessions(
  table: SessionTable, sessions: readonly HaSyncedSession[],
): void {
  for (const synced of sessions) {
    const key = parseKey(synced.key);
    if (!key || table.lookup(key)) continue;

    table.install(key, {
      ingressZone: synced.ingressZone,
      egressZone: synced.egressZone,
      ingressInterface: synced.ingressInterface,
      egressInterface: synced.egressInterface,
      timeoutSec: synced.timeoutSec,
      policyId: synced.policyId,
    });
  }
}

function keyText(key: FlowKey): string {
  return [key.protocol, key.sourceIP, key.sourcePort, key.destIP, key.destPort].join('|');
}

function parseKey(text: string): FlowKey | null {
  const parts = text.split('|');
  if (parts.length !== 5) return null;

  return makeFlowKey(
    parts[1], Number.parseInt(parts[2], 10),
    parts[3], Number.parseInt(parts[4], 10),
    Number.parseInt(parts[0], 10));
}
