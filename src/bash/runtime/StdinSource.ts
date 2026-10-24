export interface StdinReader {
  readRecord(delimiter: string): { readonly text: string; readonly terminated: boolean } | null;
  readCharacters(count: number): string | null;
  readRest(): string;
  exhausted(): boolean;
}

export class StdinSource implements StdinReader {
  private position = 0;

  constructor(private readonly data: string) {}

  exhausted(): boolean {
    return this.position >= this.data.length;
  }

  readRest(): string {
    const rest = this.data.slice(this.position);
    this.position = this.data.length;
    return rest;
  }

  readRecord(delimiter: string): { readonly text: string; readonly terminated: boolean } | null {
    if (this.exhausted()) return null;
    const end = delimiter === '' ? -1 : this.data.indexOf(delimiter, this.position);
    if (end < 0) return { text: this.readRest(), terminated: false };
    const text = this.data.slice(this.position, end);
    this.position = end + delimiter.length;
    return { text, terminated: true };
  }

  readCharacters(count: number): string | null {
    if (this.exhausted()) return null;
    const text = this.data.slice(this.position, this.position + count);
    this.position += text.length;
    return text;
  }
}
