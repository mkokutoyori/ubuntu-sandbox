import net from 'node:net';
import type { TcpStack } from '@/network/tcp/TcpStack';
import { bytesToFileText, fileTextToBytes } from '@/crypto/encoding';
import { bytesToBinaryString, binaryStringToBytes } from '@/network/http/https/TlsRecordWire';

export interface TcpRelay {
  readonly port: number;
  stop(): void;
}

export async function startTcpRelay(stack: TcpStack, address: string, port: number): Promise<TcpRelay> {
  const server = net.createServer((real) => {
    const simulated = stack.connect(address, port);
    if (!simulated) { real.destroy(); return; }
    simulated.onData((data) => { real.write(Buffer.from(binaryStringToBytes(String(data)))); });
    simulated.onClose(() => { real.end(); });
    real.on('data', (chunk) => { simulated.write(bytesToBinaryString(chunk)); });
    real.on('close', () => { simulated.close(); });
    real.on('error', () => undefined);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { port: (server.address() as net.AddressInfo).port, stop: () => { server.close(); } };
}

export function hostFileBytes(text: string): Buffer {
  return Buffer.from(fileTextToBytes(text));
}

export function fileTextOf(bytes: Uint8Array): string {
  return bytesToFileText(bytes);
}
