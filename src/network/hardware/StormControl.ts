import type { StormControlSetting } from '../devices/shells/cisco/stormControlSyntax';

export type StormTrafficType = 'broadcast' | 'multicast' | 'unicast';
export type StormControlVerdict = 'forward' | 'drop';

export interface StormThreshold {
  readonly unit: 'percent' | 'pps' | 'bps';
  readonly upper: number;
  readonly lower: number;
}

interface StormWindow {
  windowStart: number;
  frames: number;
  bits: number;
  suppressing: boolean;
}

const WINDOW_MS = 1000;

function emptyWindow(now: number): StormWindow {
  return { windowStart: now, frames: 0, bits: 0, suppressing: false };
}

export class StormControl {
  private readonly thresholds = new Map<StormTrafficType, StormThreshold>();
  private readonly windows = new Map<StormTrafficType, StormWindow>();
  private action: 'shutdown' | 'trap' | null = null;
  private suppressedFrames = 0;

  apply(setting: StormControlSetting): void {
    if (setting.kind === 'action') {
      this.action = setting.action === 'shutdown' ? 'shutdown' : 'trap';
      return;
    }
    this.thresholds.set(setting.type as StormTrafficType, {
      unit: setting.unit, upper: setting.upper, lower: setting.lower,
    });
  }

  clearLevel(type: StormTrafficType): void {
    this.thresholds.delete(type);
    this.windows.delete(type);
  }

  clearAction(): void { this.action = null; }

  isConfigured(): boolean { return this.thresholds.size > 0; }

  getAction(): 'shutdown' | 'trap' | null { return this.action; }

  getThreshold(type: StormTrafficType): StormThreshold | undefined {
    return this.thresholds.get(type);
  }

  getSuppressedFrames(): number { return this.suppressedFrames; }

  currentLevelPercent(type: StormTrafficType, speedMbps: number, now: number): number {
    const window = this.windows.get(type);
    if (!window || speedMbps <= 0) return 0;
    if (now - window.windowStart >= WINDOW_MS) return 0;
    return (window.bits / (speedMbps * 1_000_000)) * 100;
  }

  admit(
    type: StormTrafficType, frameBits: number, speedMbps: number, now: number,
  ): StormControlVerdict {
    const threshold = this.thresholds.get(type);
    if (!threshold) return 'forward';

    let window = this.windows.get(type);
    if (!window || now - window.windowStart >= WINDOW_MS) {
      window = emptyWindow(now);
      this.windows.set(type, window);
    }
    window.frames += 1;
    window.bits += frameBits;

    const measured = this.measure(threshold, window, speedMbps);
    if (window.suppressing) {
      if (measured <= threshold.lower) window.suppressing = false;
    } else if (measured > threshold.upper) {
      window.suppressing = true;
    }
    if (!window.suppressing) return 'forward';
    this.suppressedFrames += 1;
    return 'drop';
  }

  private measure(
    threshold: StormThreshold, window: StormWindow, speedMbps: number,
  ): number {
    if (threshold.unit === 'pps') return window.frames;
    if (threshold.unit === 'bps') return window.bits;
    if (speedMbps <= 0) return 0;
    return (window.bits / (speedMbps * 1_000_000)) * 100;
  }
}
