export interface ReferenceUpdate {
  readonly offset: number;
  readonly nowSeconds: number;
  readonly referenceTime: number;
  readonly residualFrequency: number;
  readonly skew: number;
  readonly frequency: number;
}

export class ReferenceTracking {
  private lastOffsetValue = 0;
  private averageSquareOffset = 0;
  private averageMoving = false;
  private lastUpdateSeconds = 0;
  private updateIntervalValue = 0;
  private referenceTimeValue = 0;
  private residualFrequencyValue = 0;
  private skewValue = 0;
  private frequencyValue = 0;

  record(update: ReferenceUpdate): void {
    this.updateIntervalValue = this.lastUpdateSeconds !== 0 ? update.nowSeconds - this.lastUpdateSeconds : 0;
    this.lastUpdateSeconds = update.nowSeconds;
    this.lastOffsetValue = update.offset;
    this.referenceTimeValue = update.referenceTime;
    this.residualFrequencyValue = update.residualFrequency;
    this.skewValue = update.skew;
    this.frequencyValue = update.frequency;
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
    this.skewValue = 0;
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
