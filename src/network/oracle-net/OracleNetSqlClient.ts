import type { OracleNetSession } from './OracleNetClient';
import {
  OracleNetCallId, OracleNetCallStatus, encodeRequest, decodeResponse, WIRE_CHUNK_BYTES,
  type OracleNetClientIdentity, type OracleNetRequest, type OracleNetResponse,
} from './wire/OracleNetCall';

const CHANNEL_LOST: OracleNetResponse = {
  status: OracleNetCallStatus.Error,
  error: 'ORA-03113: end-of-file on communication channel',
};

/**
 * One request, one reply, over a session that is really open — the only
 * writing of this exchange. Every client of a remote database goes
 * through it, so a closed channel answers the same ORA- code whoever
 * asked.
 */
export function callOverOracleNet(
  session: OracleNetSession | null, request: OracleNetRequest,
): OracleNetResponse {
  if (!session || !session.isOpen()) return CHANNEL_LOST;
  const answer = session.call(encodeRequest(request));
  return (answer ? decodeResponse(answer) : null) ?? CHANNEL_LOST;
}

export function logonOverOracleNet(
  session: OracleNetSession | null,
  credentials: {
    username: string; password: string; asSysdba: boolean;
    identity: OracleNetClientIdentity;
  },
): OracleNetResponse {
  return callOverOracleNet(session, {
    call: OracleNetCallId.Logon,
    body: {
      username: credentials.username,
      password: credentials.password,
      asSysdba: credentials.asSysdba,
      identity: credentials.identity,
    },
  });
}

export function executeOverOracleNet(
  session: OracleNetSession | null, sql: string,
): OracleNetResponse {
  return callOverOracleNet(session, {
    call: OracleNetCallId.Execute,
    body: { sql },
  });
}

function shipChunked(
  session: OracleNetSession | null,
  body: string,
  frame: (chunk: string, index: number, count: number) => OracleNetRequest,
): OracleNetResponse {
  const count = Math.max(1, Math.ceil(body.length / WIRE_CHUNK_BYTES));
  let last: OracleNetResponse = CHANNEL_LOST;
  for (let i = 0; i < count; i++) {
    const chunk = body.slice(i * WIRE_CHUNK_BYTES, (i + 1) * WIRE_CHUNK_BYTES);
    last = callOverOracleNet(session, frame(chunk, i, count));
    if (last.status === OracleNetCallStatus.Error) return last;
  }
  return last;
}

export function shipRedoOverOracleNet(
  session: OracleNetSession | null,
  journal: {
    thread: number; sequence: number; name: string; scn: number;
    body: string; fromDbUniqueName: string;
  },
): OracleNetResponse {
  return shipChunked(session, journal.body, (chunk, chunkIndex, chunkCount) => ({
    call: OracleNetCallId.ShipRedo,
    body: {
      thread: journal.thread,
      sequence: journal.sequence,
      name: journal.name,
      scn: journal.scn,
      body: chunk,
      chunkIndex, chunkCount,
      fromDbUniqueName: journal.fromDbUniqueName,
    },
  }));
}

export function shipDatafileOverOracleNet(
  session: OracleNetSession | null,
  datafile: {
    kind: 'DATAFILE' | 'CONTROLFILE';
    fileNo: number; path: string; tablespace: string; tablespaceType: string;
    sizeBytes: number; body: string; fromDbUniqueName: string;
  },
): OracleNetResponse {
  return shipChunked(session, datafile.body, (chunk, chunkIndex, chunkCount) => ({
    call: OracleNetCallId.ShipDatafile,
    body: {
      kind: datafile.kind,
      fileNo: datafile.fileNo,
      path: datafile.path,
      tablespace: datafile.tablespace,
      tablespaceType: datafile.tablespaceType,
      sizeBytes: datafile.sizeBytes,
      body: chunk,
      chunkIndex, chunkCount,
      fromDbUniqueName: datafile.fromDbUniqueName,
    },
  }));
}
