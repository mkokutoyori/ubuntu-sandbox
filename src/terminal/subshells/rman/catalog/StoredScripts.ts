import { err, ok, type Result } from '../core/Result';
import type { RmanError } from '../core/RmanError';

export type StoreOutcome = 'created' | 'replaced';

export class StoredScripts {
  private readonly _scripts = new Map<string, { name: string; lines: readonly string[] }>();

  create(name: string, lines: readonly string[]): Result<StoreOutcome, RmanError> {
    if (this._scripts.has(keyOf(name))) {
      return err({ code: 'RMAN_03002', message: `script ${name} already exists` });
    }
    this._scripts.set(keyOf(name), { name, lines: [...lines] });
    return ok('created');
  }

  replace(name: string, lines: readonly string[]): StoreOutcome {
    const known = this._scripts.has(keyOf(name));
    this._scripts.set(keyOf(name), { name, lines: [...lines] });
    return known ? 'replaced' : 'created';
  }

  read(name: string): Result<readonly string[], RmanError> {
    const found = this._scripts.get(keyOf(name));
    return found === undefined ? missing(name) : ok(found.lines);
  }

  remove(name: string): Result<void, RmanError> {
    return this._scripts.delete(keyOf(name)) ? ok(undefined) : missing(name);
  }

  names(): string[] {
    return [...this._scripts.values()].map(script => script.name).sort();
  }
}

function keyOf(name: string): string {
  return name.replace(/^'|'$/g, '').toLowerCase();
}

function missing(name: string): Result<never, RmanError> {
  return err({ code: 'RMAN_03002', message: `script ${name.replace(/^'|'$/g, '')} not found` });
}
