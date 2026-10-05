import type { LinuxPC } from '@/network/devices/LinuxPC';
import type { LinuxServer } from '@/network/devices/LinuxServer';

export const settle = (): Promise<void> => new Promise<void>((resolve) => setTimeout(resolve, 20));

export async function reachedThrough(
  pc: LinuxPC, srv: LinuxServer, command: string, listenOn: 'client' | 'server', port: number,
): Promise<{ reached: boolean; replies: string[] }> {
  const reached: string[] = [];
  srv.getTcpStack().listen(8080, {
    onAccept: (socket) => {
      reached.push(socket.remoteIp);
      socket.onData((data) => socket.send(`ECHO:${String(data)}`));
    },
  });
  await pc.executeCommand(command, 'admin\n');
  const replies: string[] = [];
  const origin = listenOn === 'client' ? pc : srv;
  const socket = origin.getTcpStack().connect('127.0.0.1', port, { onData: (data) => replies.push(String(data)) });
  await settle();
  socket?.send('probe');
  await settle();
  return { reached: reached.length > 0, replies };
}
