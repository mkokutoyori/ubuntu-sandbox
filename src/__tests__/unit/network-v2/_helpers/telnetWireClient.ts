import { parseTelnetChunk, toNvtText, fromNvtText } from '@/network/protocols/telnet/TelnetCodec';
import { TelnetNegotiator } from '@/network/protocols/telnet/TelnetNegotiator';
import type { LinuxPC } from '@/network/devices/LinuxPC';

interface WireSocket {
  write(data: string): void;
  close(): void;
  onData(handler: (data: string) => void): () => void;
}

export class WireTelnet {
  private carry: readonly number[] = [];
  private readonly negotiator = new TelnetNegotiator({ offer: [], request: [] });
  received = '';

  constructor(private readonly socket: WireSocket) {
    socket.onData((chunk) => {
      const parsed = parseTelnetChunk(chunk, this.carry);
      this.carry = parsed.carry;
      const reply = this.negotiator.respond(parsed.negotiations);
      if (reply) socket.write(reply);
      this.received += fromNvtText(parsed.data);
    });
  }

  send(line: string): void { this.socket.write(toNvtText(`${line}\n`)); }
  close(): void { this.socket.close(); }
}

export const settle = async (): Promise<void> => {
  for (let i = 0; i < 8; i++) await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 20));
};

export async function connectTelnet(pc: LinuxPC, ip: string): Promise<WireTelnet> {
  const socket = await (pc as unknown as { tcpConnect: (h: string, p: number) => Promise<WireSocket | null> })
    .tcpConnect(ip, 23);
  if (!socket) throw new Error('no telnet socket');
  const telnet = new WireTelnet(socket);
  await settle();
  return telnet;
}
