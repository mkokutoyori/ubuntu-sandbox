/**
 * Simple cron management for Linux simulation.
 */

export class LinuxCronManager {
  private entries: string[] = [];

  install(crontabContent: string): void {
    this.entries = crontabContent.split('\n').filter(l => l.trim().length > 0);
  }

  list(): string | null {
    if (this.entries.length === 0) return null;
    return this.entries.join('\n');
  }

  remove(): void {
    this.entries = [];
  }
}
