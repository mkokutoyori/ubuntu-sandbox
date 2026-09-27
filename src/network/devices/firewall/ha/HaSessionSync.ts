import { makeFlowKey, type FlowKey } from '../session/FlowKey';
import type { HaSyncedSession, VdomSessions } from './HaTypes';

export function exportSessions(tables: readonly VdomSessions[]): readonly HaSyncedSession[] {
  return tables.flatMap(({ vdom, table }) => table.view().all().map(session => ({
    vdom,
    key: keyText(session.c2s),
    ingressZone: session.ingressZone,
    egressZone: session.egressZone,
    ingressInterface: session.ingressInterface,
    egressInterface: session.egressInterface,
    timeoutSec: session.timeoutSec,
    policyId: session.policyId,
  })));
}

export function importSessions(
  tables: readonly VdomSessions[], sessions: readonly HaSyncedSession[],
): void {
  for (const synced of sessions) {
    const table = tables.find(({ vdom }) => vdom === synced.vdom)?.table;
    const key = parseKey(synced.key);
    if (!table || !key || table.lookup(key)) continue;

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
