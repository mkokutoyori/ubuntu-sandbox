import type { TcpStream } from '@/network/tcp/types';
import type { SshSession } from './session/SshSession';
import { isOk } from './Result';

export type TunnelOpener = (host: string, port: number) => Promise<TcpStream | null>;

export function joinWhenReady(near: TcpStream, far: Promise<TcpStream | null>): void {
  const queued: string[] = [];
  let nearClosed = false;
  const offData = near.onData((data) => { queued.push(data); });
  const offClose = near.onClose?.(() => { nearClosed = true; });
  void far.then((peer) => {
    offData();
    offClose?.();
    if (peer === null) {
      near.close();
      return;
    }
    for (const data of queued) peer.write(data);
    if (nearClosed) {
      peer.close();
      return;
    }
    near.onData((data) => peer.write(data));
    peer.onData((data) => near.write(data));
    peer.onClose?.(() => near.close());
    near.onClose?.(() => peer.close());
  });
}

export function tunnelThroughSession(
  session: SshSession | null, onRefused: (line: string) => void = () => undefined,
): TunnelOpener | null {
  if (session === null) return null;
  return async (host, port) => {
    const opened = await session.openDirectTcpip(host, port);
    if (isOk(opened)) return opened.value;
    const reason = opened.error.kind === 'CHANNEL_ERROR' ? opened.error.message : opened.error.kind;
    onRefused(`channel 0: open failed: ${reason}`);
    return null;
  };
}
