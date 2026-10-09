export class SyslogStreamFraming {
  private buffer = '';

  constructor(private readonly onMessage: (message: string) => void) {}

  push(data: string): void {
    this.buffer += data;
    for (;;) {
      const counted = /^(\d+) /.exec(this.buffer);
      if (counted !== null) {
        const length = Number(counted[1]);
        const start = counted[0].length;
        if (this.buffer.length < start + length) return;
        this.onMessage(this.buffer.slice(start, start + length));
        this.buffer = this.buffer.slice(start + length);
        continue;
      }
      const end = this.buffer.indexOf('\n');
      if (end < 0) return;
      const line = this.buffer.slice(0, end);
      this.buffer = this.buffer.slice(end + 1);
      if (line.length > 0) this.onMessage(line);
    }
  }
}
