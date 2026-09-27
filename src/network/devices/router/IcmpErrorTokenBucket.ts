export interface TokenBucketSetting {
  readonly intervalMs: number;
  readonly bucketSize: number;
}

export const IOS_IPV6_ERROR_INTERVAL: TokenBucketSetting = { intervalMs: 100, bucketSize: 10 };

export class IcmpErrorTokenBucket {
  private setting: TokenBucketSetting | null;
  private tokens: number;
  private refilledAt: number | null = null;

  constructor(private readonly defaultSetting: TokenBucketSetting | null, private readonly now: () => number) {
    this.setting = defaultSetting;
    this.tokens = defaultSetting?.bucketSize ?? 0;
  }

  current(): TokenBucketSetting | null {
    return this.setting;
  }

  configure(setting: TokenBucketSetting | null): void {
    this.setting = setting ?? this.defaultSetting;
    this.tokens = this.setting?.bucketSize ?? 0;
    this.refilledAt = null;
  }

  admit(): boolean {
    const setting = this.setting;
    if (setting === null || setting.intervalMs === 0) return true;
    const now = this.now();
    if (this.refilledAt === null) {
      this.refilledAt = now;
    } else {
      const earned = Math.floor((now - this.refilledAt) / setting.intervalMs);
      if (earned > 0) {
        this.tokens = Math.min(setting.bucketSize, this.tokens + earned);
        this.refilledAt = this.tokens === setting.bucketSize ? now : this.refilledAt + earned * setting.intervalMs;
      }
    }
    if (this.tokens === 0) return false;
    this.tokens--;
    return true;
  }

  runningConfigLines(): string[] {
    const setting = this.setting;
    const standard = this.defaultSetting;
    if (setting === null || standard === null) return [];
    if (setting.intervalMs === standard.intervalMs && setting.bucketSize === standard.bucketSize) return [];
    const bucket = setting.bucketSize === standard.bucketSize ? '' : ` ${setting.bucketSize}`;
    return [`ipv6 icmp error-interval ${setting.intervalMs}${bucket}`];
  }
}
