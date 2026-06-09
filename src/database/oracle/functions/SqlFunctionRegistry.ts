import type { SqlFunctionBundle, SqlFunctionImpl } from './types';

export class SqlFunctionRegistry {
  private readonly implementations = new Map<string, SqlFunctionImpl>();

  register(name: string, impl: SqlFunctionImpl): void {
    this.implementations.set(name.toUpperCase(), impl);
  }

  registerBundle(bundle: SqlFunctionBundle): void {
    for (const [name, impl] of Object.entries(bundle)) {
      this.register(name, impl);
    }
  }

  resolve(name: string, packageName?: string | null): SqlFunctionImpl | undefined {
    const key = packageName
      ? `${packageName.toUpperCase()}.${name.toUpperCase()}`
      : name.toUpperCase();
    return this.implementations.get(key);
  }

  has(name: string, packageName?: string | null): boolean {
    return this.resolve(name, packageName) !== undefined;
  }
}
