import type { EndHost } from '@/network/devices/EndHost';
import type { TcpSocket } from '@/network/tcp/TcpStack';
import { simulatedDigest } from '@/network/dns/dnssec/Digest';

export interface TlsClientHello {
  readonly tls: 'client-hello';
  readonly random: string;
  readonly sni: string;
  readonly alpn: string;
}

export interface TlsServerHello {
  readonly tls: 'server-hello';
  readonly random: string;
  readonly alpn: string;
  readonly certificateSubject: string;
}

export interface TlsAlert {
  readonly tls: 'alert';
  readonly description: string;
}

export interface TlsApplicationData {
  readonly tls: 'application-data';
  readonly seq: number;
  readonly ciphertext: readonly number[];
}

export type TlsRecord = TlsClientHello | TlsServerHello | TlsAlert | TlsApplicationData;

export function deriveSessionKey(clientRandom: string, serverRandom: string): string {
  return simulatedDigest(`${clientRandom}|${serverRandom}`);
}

function keystreamByte(key: string, seq: number, index: number): number {
  const position = seq * 7 + index;
  return (key.charCodeAt(position % key.length) + position) & 0xff;
}

export function encryptBytes(key: string, seq: number, plaintext: Uint8Array): number[] {
  const ciphertext: number[] = [];
  for (let i = 0; i < plaintext.length; i++) {
    ciphertext.push(plaintext[i] ^ keystreamByte(key, seq, i));
  }
  return ciphertext;
}

export function decryptBytes(key: string, seq: number, ciphertext: readonly number[]): Uint8Array {
  const plaintext = new Uint8Array(ciphertext.length);
  for (let i = 0; i < ciphertext.length; i++) {
    plaintext[i] = ciphertext[i] ^ keystreamByte(key, seq, i);
  }
  return plaintext;
}

export type TlsByteRequestHandler = (requestBytes: Uint8Array) => Uint8Array | null;

let serverRandomCounter = 0;
let clientRandomCounter = 0;

export function bindTlsByteService(
  host: EndHost,
  port: number,
  alpn: string,
  onRequest: TlsByteRequestHandler,
): void {
  host.getTcpStack().listen(port, {
    onAccept: (socket: TcpSocket) => {
      let sessionKey: string | null = null;
      socket.onData((data) => {
        const record = data as TlsRecord;
        if (record?.tls === 'client-hello') {
          if (record.alpn !== alpn) {
            socket.send({ tls: 'alert', description: 'no_application_protocol' } satisfies TlsAlert);
            socket.close();
            return;
          }
          const serverRandom = `srv-${++serverRandomCounter}`;
          sessionKey = deriveSessionKey(record.random, serverRandom);
          socket.send({
            tls: 'server-hello', random: serverRandom, alpn, certificateSubject: record.sni,
          } satisfies TlsServerHello);
          return;
        }
        if (record?.tls === 'application-data' && sessionKey) {
          const requestBytes = decryptBytes(sessionKey, record.seq, record.ciphertext);
          const responseBytes = onRequest(requestBytes);
          if (responseBytes) {
            socket.send({
              tls: 'application-data',
              seq: record.seq + 1,
              ciphertext: encryptBytes(sessionKey, record.seq + 1, responseBytes),
            } satisfies TlsApplicationData);
          }
          socket.close();
        }
      });
    },
  });
}

export function unbindTlsByteService(host: EndHost, port: number): void {
  host.getTcpStack().closeListener(port);
}

export interface TlsRequestOptions {
  readonly sni?: string;
  readonly timeoutMs?: number;
}

export async function sendTlsRequest(
  host: EndHost,
  serverIP: string,
  port: number,
  alpn: string,
  requestBytes: Uint8Array,
  options: TlsRequestOptions = {},
): Promise<Uint8Array | null> {
  const socket = await host.tcpConnect(serverIP, port);
  if (!socket) return null;

  const timeoutMs = options.timeoutMs ?? 2000;
  const clientRandom = `cli-${++clientRandomCounter}`;

  return new Promise<Uint8Array | null>((resolve) => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    let sessionKey: string | null = null;
    let settled = false;
    const finish = (result: Uint8Array | null): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve(result);
    };

    socket.onData((data) => {
      const record = data as TlsRecord;
      if (record?.tls === 'server-hello') {
        sessionKey = deriveSessionKey(clientRandom, record.random);
        socket.send({
          tls: 'application-data',
          seq: 0,
          ciphertext: encryptBytes(sessionKey, 0, requestBytes),
        } satisfies TlsApplicationData);
        return;
      }
      if (record?.tls === 'alert') {
        finish(null);
        socket.close();
        return;
      }
      if (record?.tls === 'application-data' && sessionKey) {
        finish(decryptBytes(sessionKey, record.seq, record.ciphertext));
        socket.close();
      }
    });
    socket.onClose(() => finish(null));

    socket.send({
      tls: 'client-hello', random: clientRandom, sni: options.sni ?? serverIP, alpn,
    } satisfies TlsClientHello);
    timer = setTimeout(() => { finish(null); socket.close(); }, timeoutMs);
  });
}
