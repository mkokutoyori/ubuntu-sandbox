export class EdnsSupportCache {
  private readonly unsupportedUntilMs = new Map<string, number>();

  constructor(
    private readonly now: () => number,
    private readonly timeoutSeconds: () => number,
  ) {}

  isUnsupported(server: string): boolean {
    const until = this.unsupportedUntilMs.get(server);
    if (until === undefined) return false;
    if (this.now() < until) return true;
    this.unsupportedUntilMs.delete(server);
    return false;
  }

  markUnsupported(server: string): void {
    this.unsupportedUntilMs.set(server, this.now() + this.timeoutSeconds() * 1000);
  }

  flush(): void {
    this.unsupportedUntilMs.clear();
  }
}
