/** Résultat typé du parsing : ce que la commande consomme dans execute(). */
export class ParsedArgs {
  constructor(
    private readonly positionals: Map<string, unknown>,
    private readonly options: Map<string, unknown>,
    public readonly rest: readonly string[] = [],
  ) {}

  get<T>(name: string): T {
    if (this.positionals.has(name)) return this.positionals.get(name) as T;
    return this.options.get(name) as T;
  }

  flag(name: string): boolean {
    return this.options.get(name) === true;
  }

  has(name: string): boolean {
    return this.positionals.has(name) || this.options.has(name);
  }

  usedOptions(): string[] {
    return [...this.options.keys()];
  }
}
