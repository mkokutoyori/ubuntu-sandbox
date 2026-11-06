import { IP_PROTO_TCP } from '../../../core/types';
import {
  decodeEprtArgument, decodeEpsvReplyArgument, decodePortArgument,
} from '../../../ftp/DataChannel';
import type { ExpectedFlow } from './ExpectedFlowTable';
import type { FirewallSession } from './SessionTable';
import type { FlowDirection } from './TcpStateMachine';

const PASV_REPLY = /^227 [^(]*\(([\d,]+)\)/m;
const EPSV_REPLY = /^229 .*$/m;
const PORT_COMMAND = /^PORT\s+([^\r\n]+)/im;
const EPRT_COMMAND = /^EPRT\s+([^\r\n]+)/im;

function passiveDataFlow(session: FirewallSession, payload: string): ExpectedFlow | null {
  const translation = session.translation;
  if (translation && translation.translatedDest !== translation.originalDest) return null;

  const base = {
    protocol: IP_PROTO_TCP,
    sourceIP: session.c2s.sourceIP,
    parentSessionId: session.id,
    policyId: session.policyId,
    helper: 'ftp',
  };
  const pasv = PASV_REPLY.exec(payload);
  if (pasv) {
    const endpoint = decodePortArgument(pasv[1]);
    return endpoint ? { ...base, destIP: endpoint.address, destPort: endpoint.port } : null;
  }
  const epsv = EPSV_REPLY.exec(payload);
  if (epsv) {
    const port = decodeEpsvReplyArgument(epsv[0]);
    return port === null ? null : { ...base, destIP: session.c2s.destIP, destPort: port };
  }
  return null;
}

function activeDataFlow(session: FirewallSession, payload: string): ExpectedFlow | null {
  const translation = session.translation;
  if (translation && translation.translatedSource !== translation.originalSource) return null;

  const base = {
    protocol: IP_PROTO_TCP,
    sourceIP: session.c2s.destIP,
    parentSessionId: session.id,
    policyId: session.policyId,
    helper: 'ftp',
  };
  const port = PORT_COMMAND.exec(payload);
  if (port) {
    const endpoint = decodePortArgument(port[1].trim());
    return endpoint ? { ...base, destIP: endpoint.address, destPort: endpoint.port } : null;
  }
  const eprt = EPRT_COMMAND.exec(payload);
  if (eprt) {
    const endpoint = decodeEprtArgument(eprt[1].trim());
    return endpoint && endpoint.protocol === 1 ? { ...base, destIP: endpoint.address, destPort: endpoint.port } : null;
  }
  return null;
}

export function ftpExpectedDataFlow(
  session: FirewallSession, direction: FlowDirection, payload: string,
): ExpectedFlow | null {
  if (session.c2s.protocol !== IP_PROTO_TCP) return null;
  if (direction === 's2c') return passiveDataFlow(session, payload);
  if (direction === 'c2s') return activeDataFlow(session, payload);
  return null;
}
