import type { TcpSocket } from './TcpStack';

export class ConnectionQuota {
  private active = 0;
  private readonly waiting: Array<{ readonly socket: TcpSocket; readonly serve: () => void }> = [];

  constructor(private readonly limit: number) {}

  admit(socket: TcpSocket, serve: () => void): void {
    if (this.active < this.limit) {
      this.begin(socket, serve);
      return;
    }
    const entry = { socket, serve };
    this.waiting.push(entry);
    socket.onClose(() => {
      const index = this.waiting.indexOf(entry);
      if (index >= 0) this.waiting.splice(index, 1);
    });
  }

  private begin(socket: TcpSocket, serve: () => void): void {
    this.active++;
    socket.onClose(() => this.release());
    serve();
  }

  private release(): void {
    this.active--;
    const next = this.waiting.shift();
    if (next !== undefined) this.begin(next.socket, next.serve);
  }
}
