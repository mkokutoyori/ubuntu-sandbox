/**
 * CredSsp — a simplified stand-in for CredSSP/NLA (PRD-Windows-Server-
 * Advanced.md §5 P17, §2.1.16, MS-RDPBCGR's negotiated security protocol
 * `PROTOCOL_HYBRID`): once the TLS channel is up (`TlsClientSession`/
 * `TlsServerSession`, reused as-is — no new cryptographic primitive),
 * the client sends one JSON credential PDU over it, the server checks it
 * against local/domain accounts exactly as WinRM/SMB already do, and
 * replies with the verdict *before* any session is created — matching
 * real NLA's "authenticate before session" ordering.
 */

export interface CredSspRequest {
  readonly kind: 'credssp-request';
  readonly username: string;
  readonly password: string;
}

export interface CredSspResponse {
  readonly kind: 'credssp-response';
  readonly ok: boolean;
  readonly sessionId?: number;
}

export function encodeCredSspRequest(username: string, password: string): Uint8Array {
  const pdu: CredSspRequest = { kind: 'credssp-request', username, password };
  return new TextEncoder().encode(JSON.stringify(pdu));
}

export function decodeCredSspRequest(bytes: Uint8Array): CredSspRequest | null {
  try {
    const parsed = JSON.parse(new TextDecoder().decode(bytes)) as CredSspRequest;
    return parsed.kind === 'credssp-request' ? parsed : null;
  } catch { return null; }
}

export function encodeCredSspResponse(ok: boolean, sessionId?: number): Uint8Array {
  const pdu: CredSspResponse = { kind: 'credssp-response', ok, sessionId };
  return new TextEncoder().encode(JSON.stringify(pdu));
}

export function decodeCredSspResponse(bytes: Uint8Array): CredSspResponse | null {
  try {
    const parsed = JSON.parse(new TextDecoder().decode(bytes)) as CredSspResponse;
    return parsed.kind === 'credssp-response' ? parsed : null;
  } catch { return null; }
}

export interface CredSspAuthContext {
  checkLocal(username: string, password: string): boolean;
  checkDomain?(username: string, password: string): boolean;
}

/** Local accounts are tried first, then a domain fallback — the same ordering `WinRmServerHandler`/`SmbServerHandler` already use. */
export function verifyCredSsp(ctx: CredSspAuthContext, req: CredSspRequest): boolean {
  return ctx.checkLocal(req.username, req.password) || Boolean(ctx.checkDomain?.(req.username, req.password));
}
