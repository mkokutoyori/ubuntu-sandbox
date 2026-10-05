import { utf8ToBytes } from '@/crypto/encoding';
import type { TcpStream } from '@/network/tcp/types';
import type { ConnectionChannel } from './SshConnection';

export interface StreamEndpoints {
  readonly localIp: string;
  readonly localPort: number;
  readonly remoteIp: string;
  readonly remotePort: number;
}

export function channelAsStream(channel: ConnectionChannel, endpoints: StreamEndpoints): TcpStream {
  const dataHandlers: Array<(data: string) => void> = [];
  const closeHandlers: Array<(reason: string) => void> = [];
  const unread: string[] = [];
  const decoder = new TextDecoder();
  let finished = false;
  const finish = (reason: string): void => {
    if (finished) return;
    finished = true;
    for (const handler of [...closeHandlers]) handler(reason);
  };
  channel.onData((bytes) => {
    const text = decoder.decode(bytes, { stream: true });
    if (text === '') return;
    if (dataHandlers.length === 0) unread.push(text);
    else for (const handler of [...dataHandlers]) handler(text);
  });
  channel.onEof(() => finish('fin'));
  channel.onClose(() => finish('fin'));
  return {
    ...endpoints,
    write: (data: string) => { if (!finished) channel.write(utf8ToBytes(data)); },
    close: () => {
      if (!finished) {
        channel.eof();
        channel.close();
      }
      finish('fin');
    },
    onData: (handler) => {
      dataHandlers.push(handler);
      for (const text of unread.splice(0)) handler(text);
      return () => { dataHandlers.splice(dataHandlers.indexOf(handler), 1); };
    },
    onClose: (handler) => {
      closeHandlers.push(handler);
      if (finished) handler('fin');
      return () => { closeHandlers.splice(closeHandlers.indexOf(handler), 1); };
    },
  };
}

export function pipeChannelToStream(channel: ConnectionChannel, stream: TcpStream): void {
  const decoder = new TextDecoder();
  channel.onData((bytes) => {
    const text = decoder.decode(bytes, { stream: true });
    if (text !== '') stream.write(text);
  });
  channel.onEof(() => stream.close());
  channel.onClose(() => stream.close());
  stream.onData((text) => channel.write(utf8ToBytes(text)));
  stream.onClose?.(() => {
    channel.eof();
    channel.close();
  });
}
