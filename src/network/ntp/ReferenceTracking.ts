export interface ReferenceUpdate {
  readonly offset: number;
  readonly nowSeconds: number;
  readonly referenceTime: number;
  readonly residualFrequency: number;
  readonly skew: number;
  readonly frequency: number;
}

export interface MaxChange { readonly offset: number; readonly delay: number; readonly ignore: number }

export interface ClockEstimate { readonly frequency: number; readonly residualFrequency: number; readonly skew: number }

const INITIAL_SKEW = 1.0;

export class ReferenceTracking {
  private lastOffsetValue = 0;
  private averageSquareOffset = 0;
  private averageMoving = false;
  private lastUpdateSeconds = 0;
  private updateIntervalValue = 0;
  private referenceTimeValue = 0;
  private residualFrequencyValue = 0;
  private skewValue = INITIAL_SKEW;
  private frequencyValue = 0;
  private maxUpdateSkew = 1000e-6;
  private maxChange: MaxChange | null = null;
  private maxChangeDelay = 0;
  private maxChangeIgnore = 0;

  setMaxUpdateSkewPpm(ppm: number): void { this.maxUpdateSkew = Math.abs(ppm) * 1e-6; }

  maxUpdateSkewPpm(): number { return this.maxUpdateSkew * 1e6; }

  setMaxChange(change: MaxChange | null): void {
    this.maxChange = change;
    this.maxChangeDelay = change?.delay ?? 0;
    this.maxChangeIgnore = change?.ignore ?? 0;
  }

  checkOffset(offset: number): 'ok' | 'ignored' | 'exit' {
    if (this.maxChange === null || this.maxChangeDelay < 0) return 'ok';
    if (this.maxChangeDelay > 0) { this.maxChangeDelay--; return 'ok'; }
    if (Math.abs(offset) <= this.maxChange.offset) return 'ok';
    if (this.maxChangeIgnore === 0) return 'exit';
    if (this.maxChangeIgnore > 0) this.maxChangeIgnore--;
    return 'ignored';
  }

  estimate(manual: boolean, measuredFrequency: number, measuredSkew: number): ClockEstimate {
    const expectedSkew = this.skewValue;
    let gain: number;
    if (manual) gain = 1;
    else if (Math.abs(measuredSkew) > this.maxUpdateSkew) gain = 0;
    else gain = (3 * expectedSkew ** 2) / (3 * expectedSkew ** 2 + measuredSkew ** 2);
    gain = Math.min(1, Math.max(0, gain));
    const frequency = gain * measuredFrequency;
    const residual = measuredFrequency - frequency;
    const extraSkew = Math.sqrt(frequency ** 2 * (1 - gain) + residual ** 2 * gain);
    return { frequency, residualFrequency: residual, skew: expectedSkew + gain * (measuredSkew - expectedSkew) + extraSkew };
  }

  record(update: ReferenceUpdate): void {
    this.updateIntervalValue = this.lastUpdateSeconds !== 0 ? update.nowSeconds - this.lastUpdateSeconds : 0;
    this.lastUpdateSeconds = update.nowSeconds;
    this.lastOffsetValue = update.offset;
    this.referenceTimeValue = update.referenceTime;
    this.residualFrequencyValue = update.residualFrequency;
    this.skewValue = update.skew;
    this.frequencyValue += update.frequency * (1 - this.frequencyValue);
    const square = update.offset ** 2;
    if (this.averageMoving) {
      this.averageSquareOffset += 0.1 * (square - this.averageSquareOffset);
    } else {
      if (this.averageSquareOffset > 0 && this.averageSquareOffset < square) this.averageMoving = true;
      this.averageSquareOffset = square;
    }
  }

  reset(): void {
    this.lastOffsetValue = 0;
    this.averageSquareOffset = 0;
    this.averageMoving = false;
    this.lastUpdateSeconds = 0;
    this.updateIntervalValue = 0;
    this.referenceTimeValue = 0;
    this.residualFrequencyValue = 0;
    this.skewValue = INITIAL_SKEW;
    this.frequencyValue = 0;
  }

  lastOffset(): number { return this.lastOffsetValue; }
  rmsOffset(): number { return Math.sqrt(this.averageSquareOffset); }
  updateInterval(): number { return this.updateIntervalValue; }
  referenceTime(): number { return this.referenceTimeValue; }
  residualFrequency(): number { return this.residualFrequencyValue; }
  skew(): number { return this.skewValue; }
  frequency(): number { return this.frequencyValue; }
}
