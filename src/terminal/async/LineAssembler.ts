export class LineAssembler {
  private carry = '';

  push(chunk: string): string[] {
    const combined = this.carry + chunk;
    const parts = combined.split('\n');
    this.carry = parts.pop() ?? '';
    return parts;
  }

  flush(): string | null {
    if (this.carry === '') return null;
    const rest = this.carry;
    this.carry = '';
    return rest;
  }
}
