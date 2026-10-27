export class SocketInodes {
  private last = 0;

  next(): number {
    this.last += 1;
    return this.last;
  }

  reset(): void {
    this.last = 0;
  }
}
