import type { OracleNetSession } from './OracleNetClient';
import {
  OracleNetCallId, OracleNetCallStatus, encodeRequest, decodeResponse, REDO_CHUNK_BYTES,
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

export function shipRedoOverOracleNet(
  session: OracleNetSession | null,
  journal: {
    thread: number; sequence: number; name: string; scn: number;
    body: string; fromDbUniqueName: string;
  },
): OracleNetResponse {
  const morceaux = Math.max(1, Math.ceil(journal.body.length / REDO_CHUNK_BYTES));
  let derniere: OracleNetResponse = CHANNEL_LOST;
  for (let i = 0; i < morceaux; i++) {
    derniere = callOverOracleNet(session, {
      call: OracleNetCallId.ShipRedo,
      body: {
        thread: journal.thread,
        sequence: journal.sequence,
        name: journal.name,
        scn: journal.scn,
        body: journal.body.slice(i * REDO_CHUNK_BYTES, (i + 1) * REDO_CHUNK_BYTES),
        chunkIndex: i,
        chunkCount: morceaux,
        fromDbUniqueName: journal.fromDbUniqueName,
      },
    });
    if (derniere.status === OracleNetCallStatus.Error) return derniere;
  }
  return derniere;
}
