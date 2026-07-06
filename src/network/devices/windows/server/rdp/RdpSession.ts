/**
 * RdpSession — MS-RDPBCGR connection negotiation (PRD-Windows-Server-
 * Advanced.md §5 P17, §2.1.16): TPKT (RFC 905-descendant, MS-RDPBCGR
 * §2.2.1) carrying an X.224 Connection Request/Confirm TPDU with an
 * embedded RDP Negotiation Request/Response, followed by a real TLS 1.3
 * handshake (`TlsClientSession`/`TlsServerSession`, already delivered —
 * zero new crypto primitive, reused exactly as SSH/HTTPS/FTPS already do)
 * standing in for the CredSSP/NLA security channel, and one `CredSsp.ts`
 * credential PDU over it. A resulting RDP session is a real session-table
 * entry (`query session`/`Get-RDUserSession`, closed by `logoff`) —
 * **no bitmap/graphical pipeline is modeled** (this simulator has no
 * remote-rendering surface anywhere; PRD §2.2/§7 risk 2).
 */
import type { TcpStack, TcpSocket } from '@/network/tcp/TcpStack';
import { TlsServerSession, type TlsServerConfig } from '@/network/tls/TlsServerSession';
import { TlsClientSession, type TlsClientConfig } from '@/network/tls/TlsClientSession';
import { encodeRecords, decodeRecords } from '@/network/http/https/TlsRecordWire';
import { encryptApplicationData, decryptApplicationData } from '@/network/http/https/ApplicationDataCipher';
import {
  encodeCredSspRequest, decodeCredSspRequest, encodeCredSspResponse, decodeCredSspResponse,
  verifyCredSsp, type CredSspAuthContext,
} from './CredSsp';

export const RDP_PORT = 3389;

/** MS-RDPBCGR §2.2.1.1.1 `RDP_NEG_REQ`/`RDP_NEG_RSP` `requestedProtocols`/`selectedProtocol` flag — this simulator always negotiates CredSSP (Hybrid/NLA), the modern default. */
const PROTOCOL_HYBRID = 0x00000002;

function toBytes(data: unknown): Uint8Array {
  if (data instanceof Uint8Array) return data;
  const text = String(data);
  const bytes = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i++) bytes[i] = text.charCodeAt(i) & 0xff;
  return bytes;
}

// ─── TPKT (RFC 905-descendant, MS-RDPBCGR §2.2.1) ──────────────────────────

function encodeTpkt(payload: Uint8Array): Uint8Array {
  const length = payload.length + 4;
  const out = new Uint8Array(length);
  out[0] = 3; // version
  out[1] = 0; // reserved
  out[2] = (length >> 8) & 0xff;
  out[3] = length & 0xff;
  out.set(payload, 4);
  return out;
}

function decodeTpkt(data: Uint8Array): { payload: Uint8Array } | null {
  if (data.length < 4 || data[0] !== 3) return null;
  const length = (data[2] << 8) | data[3];
  if (data.length < length) return null;
  return { payload: data.subarray(4, length) };
}

// ─── X.224 Connection Request/Confirm + embedded RDP Negotiation ───────────

const X224_CR = 0xe0;
const X224_CC = 0xd0;
const RDP_NEG_REQ = 0x01;
const RDP_NEG_RSP = 0x02;
const RDP_NEG_FAILURE = 0x03;

function encodeX224Header(code: number): Uint8Array {
  // length-indicator, code, dst-ref(2), src-ref(2), class-option — RFC 905 §13.3/§13.4, minimal fields.
  return new Uint8Array([6, code, 0, 0, 0, 0, 0]);
}

function encodeNegBlock(type: number, value: number): Uint8Array {
  return new Uint8Array([
    type, 0,
    8, 0, // length = 8, little-endian
    value & 0xff, (value >> 8) & 0xff, (value >> 16) & 0xff, (value >> 24) & 0xff,
  ]);
}

export function encodeX224ConnectionRequest(): Uint8Array {
  const header = encodeX224Header(X224_CR);
  const neg = encodeNegBlock(RDP_NEG_REQ, PROTOCOL_HYBRID);
  const out = new Uint8Array(header.length + neg.length);
  out.set(header, 0);
  out.set(neg, header.length);
  out[0] = header.length + neg.length - 1; // length-indicator excludes itself
  return out;
}

export function decodeX224ConnectionRequest(payload: Uint8Array): boolean {
  return payload.length >= 2 && payload[1] === X224_CR;
}

export function encodeX224ConnectionConfirm(selectedProtocol: number): Uint8Array {
  const header = encodeX224Header(X224_CC);
  const neg = encodeNegBlock(RDP_NEG_RSP, selectedProtocol);
  const out = new Uint8Array(header.length + neg.length);
  out.set(header, 0);
  out.set(neg, header.length);
  out[0] = header.length + neg.length - 1;
  return out;
}

export function decodeX224ConnectionConfirm(payload: Uint8Array): { selectedProtocol: number } | null {
  if (payload.length < 2 || payload[1] !== X224_CC) return null;
  const negOffset = 7;
  if (payload.length < negOffset + 8) return null;
  const type = payload[negOffset];
  if (type === RDP_NEG_FAILURE) return null;
  if (type !== RDP_NEG_RSP) return null;
  const value = payload[negOffset + 4] | (payload[negOffset + 5] << 8) | (payload[negOffset + 6] << 16) | (payload[negOffset + 7] << 24);
  return { selectedProtocol: value };
}

// ─── Session table (`query session`/`Get-RDUserSession`, `logoff`) ─────────

export interface RdpSessionState {
  readonly sessionId: number;
  readonly userName: string;
  readonly state: 'Active' | 'Disconnected';
  readonly clientAddress: string;
}

export class RdpSessionTable {
  private readonly sessions = new Map<number, { userName: string; state: 'Active' | 'Disconnected'; clientAddress: string }>();
  private nextId = 1;

  create(userName: string, clientAddress: string): number {
    const id = this.nextId++;
    this.sessions.set(id, { userName, state: 'Active', clientAddress });
    return id;
  }

  list(): RdpSessionState[] {
    return [...this.sessions.entries()].map(([sessionId, s]) => ({ sessionId, ...s }));
  }

  get(sessionId: number): RdpSessionState | null {
    const s = this.sessions.get(sessionId);
    return s ? { sessionId, ...s } : null;
  }

  /** `logoff`/`rwinsta` — closes the session cleanly, removing it from the table (real `logoff` ends the session outright rather than just disconnecting it). */
  logoff(sessionId: number): boolean {
    return this.sessions.delete(sessionId);
  }
}

// ─── Server side ────────────────────────────────────────────────────────

export interface RdpServerContext {
  readonly tlsConfig: Omit<TlsServerConfig, 'alpnProtocols'>;
  readonly sessions: RdpSessionTable;
  readonly auth: CredSspAuthContext;
}

export class RdpServerHandler {
  constructor(private readonly ctx: RdpServerContext) {}

  register(socket: TcpSocket): void {
    let stage: 'negotiating' | 'tls' | 'established' = 'negotiating';
    let tls: TlsServerSession | null = null;
    let clientSeq = 0;
    let serverSeq = 0;

    const unsubscribe = socket.onData((data) => {
      const bytes = toBytes(data);

      if (stage === 'negotiating') {
        const decoded = decodeTpkt(bytes);
        if (!decoded || !decodeX224ConnectionRequest(decoded.payload)) return;
        socket.send(encodeTpkt(encodeX224ConnectionConfirm(PROTOCOL_HYBRID)));
        stage = 'tls';
        tls = new TlsServerSession(this.ctx.tlsConfig);
        return;
      }

      if (stage === 'tls') {
        const incoming = decodeRecords(bytes);
        const reply = tls!.handle(incoming);
        if (reply && reply.length > 0) socket.send(encodeRecords(reply));
        if (tls!.result === 'accept') stage = 'established';
        return;
      }

      // established: one CredSSP credential PDU decides whether a session is created.
      const { plaintext, nextSeq } = decryptApplicationData(tls!.clientApplicationTrafficSecret!, clientSeq, decodeRecords(bytes));
      clientSeq = nextSeq;
      const req = decodeCredSspRequest(plaintext);
      if (!req) return;

      const ok = verifyCredSsp(this.ctx.auth, req);
      const sessionId = ok ? this.ctx.sessions.create(req.username, socket.remoteIp ?? '0.0.0.0') : undefined;
      const respBytes = encodeCredSspResponse(ok, sessionId);
      const { records, nextSeq: serverNextSeq } = encryptApplicationData(tls!.serverApplicationTrafficSecret!, serverSeq, respBytes);
      serverSeq = serverNextSeq;
      socket.send(encodeRecords(records));

      if (!ok) { unsubscribe(); socket.close(); }
    });
  }
}

// ─── Client side ────────────────────────────────────────────────────────

export interface RdpDialResult {
  readonly ok: boolean;
  readonly error?: string;
  readonly sessionId?: number;
}

export function dialRdp(
  tcpStack: TcpStack, targetIp: string, username: string, password: string, tlsConfig: TlsClientConfig,
): RdpDialResult {
  const socket = tcpStack.connect(targetIp, RDP_PORT);
  if (!socket || socket.state !== 'established') {
    return { ok: false, error: `RDP: could not connect to ${targetIp}:${RDP_PORT}` };
  }

  let cc: { selectedProtocol: number } | null = null;
  const unsubNeg = socket.onData((data) => {
    const decoded = decodeTpkt(toBytes(data));
    if (decoded) cc = decodeX224ConnectionConfirm(decoded.payload);
  });
  socket.send(encodeTpkt(encodeX224ConnectionRequest()));
  unsubNeg();
  if (!cc) return { ok: false, error: 'RDP Negotiation Failure' };

  const tls = new TlsClientSession(tlsConfig);
  let clientSeq = 0;
  let serverSeq = 0;
  const unsubTls = socket.onData((data) => {
    if (tls.result !== null) return;
    const incoming = decodeRecords(toBytes(data));
    const nextFlight = tls.handle(incoming);
    if (nextFlight && nextFlight.length > 0) socket.send(encodeRecords(nextFlight));
  });
  const firstFlight = tls.start();
  socket.send(encodeRecords(firstFlight));
  unsubTls();
  if (tls.result !== 'success') {
    socket.close();
    return { ok: false, error: `TLS handshake with ${targetIp} port ${RDP_PORT} failed` };
  }

  const { records, nextSeq: clientNextSeq } = encryptApplicationData(
    tls.clientApplicationTrafficSecret!, clientSeq, encodeCredSspRequest(username, password),
  );
  clientSeq = clientNextSeq;

  let responseRecords: ReturnType<typeof decodeRecords> | null = null;
  const unsubCredSsp = socket.onData((data) => { responseRecords = decodeRecords(toBytes(data)); });
  socket.send(encodeRecords(records));
  unsubCredSsp();
  if (!responseRecords) return { ok: false, error: 'Empty reply from server' };

  const { plaintext, nextSeq: serverNextSeq } = decryptApplicationData(tls.serverApplicationTrafficSecret!, serverSeq, responseRecords);
  serverSeq = serverNextSeq;
  const resp = decodeCredSspResponse(plaintext);
  if (!resp || !resp.ok) return { ok: false, error: 'Logon failure: unknown user name or bad password.' };
  return { ok: true, sessionId: resp.sessionId };
}
