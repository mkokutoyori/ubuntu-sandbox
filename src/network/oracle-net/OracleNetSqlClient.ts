import type { OracleNetSession } from './OracleNetClient';
import {
  OracleNetCallId, OracleNetCallStatus, encodeRequest, decodeResponse,
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
