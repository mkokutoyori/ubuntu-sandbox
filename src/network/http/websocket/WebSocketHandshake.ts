import { sha1Hex } from '@/crypto/hash';
import type { HttpMessage } from '../semantics/types';
import { createRequest, createResponse } from '../semantics/types';

// RFC 6455 §1.3 — the magic GUID appended to the client key before hashing.
const WEBSOCKET_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

function hexToBase64(hex: string): string {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

export function computeAcceptKey(clientKey: string): string {
  return hexToBase64(sha1Hex(clientKey + WEBSOCKET_GUID));
}

export function generateWebSocketKey(): string {
  const bytes = new Uint8Array(16);
  for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

export function buildUpgradeRequest(target: string, key: string): HttpMessage {
  const req = createRequest('GET', target);
  req.headers.append('Upgrade', 'websocket');
  req.headers.append('Connection', 'Upgrade');
  req.headers.append('Sec-WebSocket-Key', key);
  req.headers.append('Sec-WebSocket-Version', '13');
  return req;
}

export interface UpgradeRequestCheck {
  ok: boolean;
  reason?: string;
  key?: string;
}

export function verifyUpgradeRequest(request: HttpMessage): UpgradeRequestCheck {
  if (request.method !== 'GET') return { ok: false, reason: 'Method must be GET' };
  if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') return { ok: false, reason: 'Missing Upgrade: websocket' };
  if (!request.headers.get('Connection')?.toLowerCase().includes('upgrade')) return { ok: false, reason: 'Missing Connection: Upgrade' };
  const key = request.headers.get('Sec-WebSocket-Key');
  if (!key) return { ok: false, reason: 'Missing Sec-WebSocket-Key' };
  if (request.headers.get('Sec-WebSocket-Version') !== '13') return { ok: false, reason: 'Unsupported Sec-WebSocket-Version' };
  return { ok: true, key };
}

export function buildUpgradeResponse(clientKey: string): HttpMessage {
  const res = createResponse(101, 'Switching Protocols');
  res.headers.append('Upgrade', 'websocket');
  res.headers.append('Connection', 'Upgrade');
  res.headers.append('Sec-WebSocket-Accept', computeAcceptKey(clientKey));
  return res;
}

export function verifyUpgradeResponse(response: HttpMessage, clientKey: string): boolean {
  if (response.statusCode !== 101) return false;
  if (response.headers.get('Upgrade')?.toLowerCase() !== 'websocket') return false;
  return response.headers.get('Sec-WebSocket-Accept') === computeAcceptKey(clientKey);
}
