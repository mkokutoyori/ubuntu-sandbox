/** Historique navigable des lignes saisies (flèches haut/bas, recherche). */
export class History {
  private readonly entries: string[] = [];
  private cursor = 0;

  constructor(private readonly capacity = 500) {}

  push(line: string): void {
    const trimmed = line.trim();
    if (trimmed && trimmed !== this.entries[this.entries.length - 1]) {
      this.entries.push(trimmed);
      if (this.entries.length > this.capacity) this.entries.shift();
    }
    this.cursor = this.entries.length;
  }

  previous(): string | undefined {
    if (this.cursor > 0) this.cursor--;
    return this.entries[this.cursor];
  }

  next(): string | undefined {
    if (this.cursor < this.entries.length) this.cursor++;
    return this.entries[this.cursor];
  }

  search(fragment: string): string[] {
    return this.entries.filter((e) => e.includes(fragment));
  }

  all(): readonly string[] {
    return this.entries;
  }
}
