export class SocketCookies {
  private readonly assigned = new Map<number, number>();
  private next = 1;

  of(socketId: number): number {
    const known = this.assigned.get(socketId);
    if (known !== undefined) return known;
    const cookie = this.next++;
    this.assigned.set(socketId, cookie);
    return cookie;
  }
}
