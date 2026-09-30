import { hmac } from '../../crypto/mac';
import { MD5 } from '../../crypto/hash';
import { DHCPv6Packet, DHCPV6_REC_MAX_RC, DHCPV6_REC_TIMEOUT_SECONDS } from './DHCPv6Packet';
import type { DHCPv6Authentication } from './DHCPv6Packet';
import { encodeDhcpv6 } from './Dhcpv6Codec';
import type { DHCPv6Server } from './DHCPv6Server';

const ZERO_DIGEST = '0'.repeat(32);

export type ReconfigureKind = 'RENEW' | 'REBIND' | 'INFORMATION-REQUEST';

export type ReconfigureRoute =
  | { readonly kind: 'direct'; readonly address: string; readonly iface: string }
  | { readonly kind: 'relay'; readonly relay: string };

export interface ReconfigureDatagram {
  readonly message: DHCPv6Packet;
  readonly route: ReconfigureRoute;
}

export interface ReconfigureTimers {
  setTimeout(callback: () => void, delayMs: number): number;
}

function hexToBytes(hex: string): Uint8Array {
  return Uint8Array.from((hex.match(/../g) ?? []).map(pair => parseInt(pair, 16)));
}

function bytesToHex(bytes: Uint8Array): string {
  return [...bytes].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

function digestInput(message: DHCPv6Packet): Uint8Array {
  const auth = message.authentication;
  const zeroed = Object.assign(new DHCPv6Packet(), message, {
    authentication: auth ? { ...auth, value: ZERO_DIGEST } : null,
  });
  return encodeDhcpv6(zeroed);
}

export function reconfigureDigest(message: DHCPv6Packet, keyHex: string): string {
  return bytesToHex(hmac(MD5, hexToBytes(keyHex), digestInput(message)));
}

export function verifyReconfigure(message: DHCPv6Packet, keyHex: string): boolean {
  const auth: DHCPv6Authentication | null = message.authentication;
  if (!auth || auth.protocol !== 3 || auth.algorithm !== 1 || auth.rdm !== 0 || auth.type !== 2) return false;
  return reconfigureDigest(message, keyHex) === auth.value;
}

export function buildReconfigure(server: DHCPv6Server, clientDuid: string, msgType: ReconfigureKind): DHCPv6Packet | null {
  if (!server.isReconfigureWilling(clientDuid) || !server.hasReconfigureKey(clientDuid)) return null;
  const message = new DHCPv6Packet();
  message.msgType = 'RECONFIGURE';
  message.transactionId = 0;
  message.serverDuid = server.getServerDuid();
  message.clientDuid = clientDuid;
  message.reconfigureMessage = msgType;
  message.authentication = { protocol: 3, algorithm: 1, rdm: 0, type: 2, value: ZERO_DIGEST };
  message.authentication = { ...message.authentication, value: reconfigureDigest(message, server.reconfigureKeyFor(clientDuid)) };
  return message;
}

export function reconfigureDatagram(server: DHCPv6Server, clientDuid: string, msgType: ReconfigureKind): ReconfigureDatagram | null {
  const message = buildReconfigure(server, clientDuid, msgType);
  if (!message) return null;
  const path = server.relayPathOf(clientDuid);
  if (path) {
    let wrapped = message;
    for (let index = path.layers.length - 1; index >= 0; index--) {
      const layer = path.layers[index];
      wrapped = DHCPv6Packet.createRelayRepl(layer.linkAddress, layer.peerAddress, layer.interfaceId, wrapped);
    }
    return { message: wrapped, route: { kind: 'relay', relay: path.relayAddress } };
  }
  const address = server.clientAddressOf(clientDuid);
  const iface = server.clientInterfaceOf(clientDuid);
  if (!address || !iface) return null;
  return { message, route: { kind: 'direct', address, iface } };
}

export function startReconfigure(
  server: DHCPv6Server, clientDuid: string, msgType: ReconfigureKind,
  transmit: (datagram: ReconfigureDatagram) => void, timers: ReconfigureTimers,
): boolean {
  const datagram = reconfigureDatagram(server, clientDuid, msgType);
  if (!datagram) return false;
  const generation = server.beginReconfigure(clientDuid, msgType);
  let attempts = 0;
  let timeout = DHCPV6_REC_TIMEOUT_SECONDS * 1000;
  const step = (): void => {
    if (server.reconfigureGeneration(clientDuid) !== generation || !server.pendingReconfigure(clientDuid)) return;
    if (attempts >= DHCPV6_REC_MAX_RC) { server.abortReconfigure(clientDuid); return; }
    attempts++;
    transmit(datagram);
    if (server.reconfigureGeneration(clientDuid) !== generation || !server.pendingReconfigure(clientDuid)) return;
    const wait = timeout;
    timeout *= 2;
    timers.setTimeout(step, wait);
  };
  step();
  return true;
}
