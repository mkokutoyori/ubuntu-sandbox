export type ConfigSaveMode = 'automatic' | 'manual';

export class SavedConfiguration {
  private mode: ConfigSaveMode = 'automatic';
  private snapshot: string | null = null;

  currentMode(): ConfigSaveMode { return this.mode; }

  setMode(mode: ConfigSaveMode, running: () => string): void {
    if (mode === this.mode) return;
    this.mode = mode;
    this.snapshot = mode === 'manual' ? running() : null;
  }

  text(): string | null { return this.snapshot; }

  save(running: string): boolean {
    if (this.mode === 'automatic' || this.snapshot === running) return false;
    this.snapshot = running;
    return true;
  }

  pendingAgainst(running: string): boolean {
    return this.mode === 'manual' && this.snapshot !== running;
  }
}
