/**
 * RidPoolClient — an additional DC's real network request for an
 * initial RID pool from the RID Master (real AD's RID pool allocation
 * genuinely travels over the same MS-DRSR RPC interface replication
 * does — this simulator reuses the exact same TCP/135 JSON-PDU
 * endpoint `ReplicationServerHandler` already serves, rather than
 * inventing a second wire protocol for it).
 */
import type { TcpStack } from '@/network/tcp/TcpStack';
import { AD_REPLICATION_PORT } from '../server/ad/replication/ReplicationSession';

export interface RidPoolRequestWire { kind: 'ridPoolRequest'; poolSize: number }
export interface RidPoolResponseWire {
  kind: 'ridPoolResponse';
  ok: boolean;
  startRid?: number;
  count?: number;
  message?: string;
}

export interface RidPoolResult { ok: boolean; startRid?: number; count?: number; message?: string }

export function requestRidPool(tcpStack: TcpStack, ridMasterAddress: string, poolSize: number): RidPoolResult {
  const socket = tcpStack.connect(ridMasterAddress, AD_REPLICATION_PORT);
  if (!socket || socket.state !== 'established') {
    return { ok: false, message: "A local error occurred (Can't contact the RID Master)" };
  }

  let result: RidPoolResult = { ok: false, message: 'no reply from RID Master' };
  const unsubscribe = socket.onData((data) => {
    if (!(data instanceof Uint8Array)) return;
    let parsed: RidPoolResponseWire;
    try { parsed = JSON.parse(new TextDecoder().decode(data)) as RidPoolResponseWire; } catch { return; }
    if (parsed.kind !== 'ridPoolResponse') return;
    if (parsed.ok && parsed.startRid !== undefined && parsed.count !== undefined) {
      result = { ok: true, startRid: parsed.startRid, count: parsed.count };
    } else {
      result = { ok: false, message: parsed.message ?? 'unable to allocate RID pool' };
    }
  });
  const request: RidPoolRequestWire = { kind: 'ridPoolRequest', poolSize };
  socket.send(new TextEncoder().encode(JSON.stringify(request)));
  unsubscribe();
  return result;
}
