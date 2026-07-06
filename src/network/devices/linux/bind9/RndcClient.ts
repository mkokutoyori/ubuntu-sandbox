/**
 * `rndc` real TCP client (PRD-Nslookup-Dig-Rndc-Runas.md §3.1/P9) — the
 * counterpart to `RndcServer.ts`: connects to a control channel (local or
 * remote, same L2 segment — see the PRD's §2.2 non-objectifs for the
 * multi-hop-routing limitation shared with the FTP/SFTP/SSH work), signs
 * the command with the given key, and verifies the server's signed reply
 * before trusting it.
 */

import type { TcpStack, TcpSocket } from '@/network/tcp/TcpStack';
import type { RndcRequest, RndcResponse } from './RndcWireCodec';
import { signRndcEnvelope, encodeRndcEnvelope, decodeRndcEnvelope, verifyRndcEnvelope } from './RndcWireCodec';

export interface RndcClientResult {
  readonly ok: boolean;
  readonly text: string;
}

const DEFAULT_TIMEOUT_MS = 5000;
const NONCE_SPACE = 0xffffffff;

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

export async function sendRndcCommand(
  tcpStack: TcpStack,
  serverIp: string,
  port: number,
  command: string,
  algorithm: string,
  secretBase64: string,
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
): Promise<RndcClientResult> {
  const nonce = Math.floor(Math.random() * NONCE_SPACE);
  const request: RndcRequest = { nonce, command };
  let envelope;
  try {
    envelope = signRndcEnvelope(request, algorithm, secretBase64);
  } catch (error) {
    return { ok: false, text: `rndc: ${(error as Error).message}` };
  }

  return new Promise((resolve) => {
    let settled = false;
    let socket: TcpSocket | null = null;
    const finish = (result: RndcClientResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket?.close();
      resolve(result);
    };
    const timer = setTimeout(
      () => finish({ ok: false, text: 'rndc: timed out waiting for a reply' }),
      timeoutMs,
    );

    let buffer = new Uint8Array(0);
    socket = tcpStack.connect(serverIp, port, {
      onData: (data) => {
        if (!(data instanceof Uint8Array)) return;
        buffer = concat(buffer, data);
        let decoded;
        try {
          decoded = decodeRndcEnvelope(buffer);
        } catch {
          finish({ ok: false, text: 'rndc: malformed reply from server' });
          return;
        }
        if (!decoded) return;

        const response = decoded.envelope.payload as RndcResponse;
        if (response.nonce !== nonce) {
          finish({ ok: false, text: 'rndc: reply nonce mismatch' });
        } else if (response.result !== 0) {
          finish({ ok: false, text: response.text || 'not authenticated' });
        } else if (!verifyRndcEnvelope(decoded.envelope, algorithm, secretBase64)) {
          finish({ ok: false, text: 'rndc: reply failed authentication' });
        } else {
          finish({ ok: true, text: response.text });
        }
      },
      onClose: () => finish({ ok: false, text: 'rndc: connection closed by remote end' }),
    });

    if (!socket || socket.state !== 'established') {
      finish({ ok: false, text: `rndc: connect failed: ${serverIp}#${port}: connection refused` });
      return;
    }
    socket.send(encodeRndcEnvelope(envelope));
  });
}
