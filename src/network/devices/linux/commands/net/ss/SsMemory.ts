import type { TcpInfo, TcpQueues } from '@/network/tcp/TcpInfo';

export interface SocketBufferSettings {
  readonly tcpReceiveBuffer: number;
  readonly tcpSendBuffer: number;
  readonly tcpSendBufferMax: number;
  readonly datagramReceiveBuffer: number;
  readonly datagramSendBuffer: number;
}

export interface SocketMemoryInput {
  readonly protocol: 'tcp' | 'udp';
  readonly listening: boolean;
  readonly queues: TcpQueues;
  readonly info: TcpInfo | null;
}

const SK_BUFF_OVERHEAD = 832;
const SK_MEM_QUANTUM = 4096;
const MAX_TCP_HEADER = 320;
const SKB_SHARED_INFO = 320;
const SK_BUFF_STRUCT = 256;
const TCP_INITIAL_CWND = 10;

function roundUpToPowerOfTwo(value: number): number {
  let power = 1;
  while (power < value) power *= 2;
  return power;
}

function sendBufferAfterHandshake(info: TcpInfo, settings: SocketBufferSettings): number {
  const perMss = roundUpToPowerOfTwo(Math.max(info.advertisedMss, info.sendMss) + MAX_TCP_HEADER + SKB_SHARED_INFO) + SK_BUFF_STRUCT;
  const segments = Math.max(TCP_INITIAL_CWND, info.sendCwnd, info.reordering + 1);
  const factor = info.congestionControl === 'bbr' ? 3 : 2;
  return Math.max(settings.tcpSendBuffer, Math.min(factor * segments * perMss, settings.tcpSendBufferMax));
}

export function skmemText(input: SocketMemoryInput, settings: SocketBufferSettings): string {
  const { queues, info } = input;
  const received = queues.unread > 0 ? SK_BUFF_OVERHEAD + queues.unread : 0;
  const queuedForSend = queues.send > 0 ? SK_BUFF_OVERHEAD + queues.send : 0;
  const charged = received + queuedForSend;
  const forwardAllocated = charged === 0 ? 0 : Math.ceil(charged / SK_MEM_QUANTUM) * SK_MEM_QUANTUM - charged;
  const receiveBuffer = input.protocol === 'udp' ? settings.datagramReceiveBuffer : settings.tcpReceiveBuffer;
  let sendBuffer = input.protocol === 'udp' ? settings.datagramSendBuffer : settings.tcpSendBuffer;
  if (input.protocol === 'tcp' && !input.listening && info !== null && info.sendMss > 0) sendBuffer = sendBufferAfterHandshake(info, settings);
  return ` skmem:(r${received},rb${receiveBuffer},t0,tb${sendBuffer},f${forwardAllocated},w${queuedForSend},o0,bl0,d0)`;
}
