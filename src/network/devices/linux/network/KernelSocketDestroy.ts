import type { TcpStack } from '@/network/tcp/TcpStack';
import type { KernelSocketRow } from './KernelSocketRows';

export type SocketDestroyOutcome = 'destroyed' | 'unsupported' | 'gone' | 'denied';

type DestroyableStack = Pick<TcpStack, 'listSockets' | 'closeListener' | 'dropRequest'>;

export function destroyKernelSocket(
  row: KernelSocketRow, stack: DestroyableStack | null, privileged: boolean,
): SocketDestroyOutcome {
  if (!privileged) return 'denied';
  const { entry } = row;
  if (entry.protocol === 'udp') return 'destroyed';
  if (entry.protocol !== 'tcp' || stack === null) return 'unsupported';
  if (row.state === 'LISTEN') {
    stack.closeListener(entry.localPort, entry.localAddress);
    return 'destroyed';
  }
  if (row.state === 'TIME_WAIT') return 'unsupported';
  const socket = stack.listSockets().find((candidate) => candidate.localIp === entry.localAddress
    && candidate.localPort === entry.localPort
    && candidate.remoteIp === entry.remoteAddress
    && candidate.remotePort === entry.remotePort);
  if (socket === undefined) return 'gone';
  if (!stack.dropRequest(socket)) socket.abort();
  return 'destroyed';
}
