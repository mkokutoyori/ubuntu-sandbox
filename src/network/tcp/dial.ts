import { IPAddress, IPv6Address } from '../core/types';
import type { PortNumber } from '../core/ports/PortNumber';
import type { TcpSocket, TcpStack } from './TcpStack';
import type { TcpDialFailure } from './types';

export type DialAddress = IPAddress | IPv6Address;

export function parseDialAddress(literal: string): DialAddress | null {
  if (!literal.includes(':')) return IPAddress.tryParse(literal);
  try {
    return new IPv6Address(literal);
  } catch {
    return null;
  }
}

export async function dialTcp(
  stack: TcpStack, destination: DialAddress, port: PortNumber,
): Promise<TcpSocket | TcpDialFailure> {
  const socket = stack.connect(destination.toString(), port.value);
  if (!socket) return { dialFailed: stack.hasEgressTo(destination.toString()) ? 'timeout' : 'unreachable' };
  if (socket.state === 'established') return socket;
  if (socket.closed) return dialFailureOf(socket);

  return new Promise((resolve) => {
    let offOpen: () => void = () => {};
    let offClose: () => void = () => {};
    offOpen = socket.onOpen(() => { offOpen(); offClose(); resolve(socket); });
    offClose = socket.onClose(() => {
      offOpen(); offClose(); resolve(dialFailureOf(socket));
    });
  });
}

function dialFailureOf(socket: { connectRefused?: boolean }): TcpDialFailure {
  // Un client ordinaire garde ici les trois issues qu'il sait dire : un
  // interdit administratif est un REFUS explicite du reseau, donc il se
  // rend comme tel. Seul le scanner, qui interroge `connectOutcome`,
  // distingue « rien n'ecoute » de « quelque chose l'interdit ».
  return { dialFailed: socket.connectRefused ? 'refused' : 'timeout' };
}
