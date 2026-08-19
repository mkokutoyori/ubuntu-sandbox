import type { TcpSocket } from '../tcp/TcpStack';
import type { BgpTransport } from './BgpSession';
import { isBgpMessage, type BgpMessage } from './messages';

export function bgpTransport(socket: TcpSocket): BgpTransport {
  return {
    send: (msg: BgpMessage) => socket.send(msg),
    close: () => socket.close(),
    onMessage: (h) => { socket.onData((d) => { if (isBgpMessage(d)) h(d); }); },
    onClose: (h) => { socket.onClose(() => h()); },
  };
}
