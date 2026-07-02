export class NamedConfigError extends Error {
  constructor(
    readonly file: string,
    readonly line: number,
    readonly detail: string,
  ) {
    super(`${file}:${line}: ${detail}`);
    this.name = 'NamedConfigError';
  }
}
