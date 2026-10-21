export class Janitor {
  private entries: Array<{ readonly id: string; readonly callback: () => void }> = [];

  add(id: string, callback: () => void): () => void {
    const entry = { id, callback };
    this.entries.unshift(entry);
    return () => {
      this.entries = this.entries.filter((candidate) => candidate !== entry);
    };
  }

  run(): void {
    for (const entry of [...this.entries]) entry.callback();
  }
}
