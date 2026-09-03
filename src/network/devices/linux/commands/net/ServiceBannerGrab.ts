/**
 * Ce qu'un port UDP laisse deviner de son service. Le pendant TCP a
 * disparu : une salutation TCP se lit sur le FIL (`TcpStack.grabGreeting`),
 * une vraie machine n'ayant aucun moyen de demander à sa cible ce qu'elle
 * annonce. UDP n'a pas de connexion, donc pas de salutation à l'ouverture,
 * et cette lecture-là reste la seule disponible.
 */

import type { Equipment } from '../../../../equipment/Equipment';

type SocketTableProbe = {
  getBannerForPort(protocol: 'tcp' | 'udp', port: number): string | null;
  getListenerProcess(protocol: 'tcp' | 'udp', port: number): string | null;
};

function socketTableOf(device: Equipment): SocketTableProbe | null {
  const st = (device as unknown as { socketTable?: SocketTableProbe }).socketTable;
  return st ?? null;
}

export function grabUdpListener(device: Equipment, port: number): string | null {
  return socketTableOf(device)?.getListenerProcess('udp', port) ?? null;
}

export function grabUdpBanner(device: Equipment, port: number): string | null {
  return socketTableOf(device)?.getBannerForPort('udp', port) ?? null;
}
