export const TCP_CHALLENGE_ACK_LIMIT = 10;
export const TCP_CHALLENGE_ACK_WINDOW_MS = 5_000;

export class AckThrottle {
  private windowStartedAt: number | null = null;
  private sentInWindow = 0;

  constructor(
    private limit = TCP_CHALLENGE_ACK_LIMIT,
    private windowMs = TCP_CHALLENGE_ACK_WINDOW_MS,
  ) {}

  configure(limit: number, windowMs: number): void {
    this.limit = limit;
    this.windowMs = windowMs;
    this.windowStartedAt = null;
    this.sentInWindow = 0;
  }

  tryAcquire(now: number): boolean {
    if (this.windowStartedAt === null || now - this.windowStartedAt >= this.windowMs) {
      this.windowStartedAt = now;
      this.sentInWindow = 0;
    }
    if (this.sentInWindow >= this.limit) return false;
    this.sentInWindow++;
    return true;
  }
}
