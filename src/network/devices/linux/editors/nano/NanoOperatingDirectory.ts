import type { EditorFsContext } from '../EditorFsContext';
import { fullPathOf } from './NanoOpening';

export type OperatingDirectoryHost = Pick<EditorFsContext, 'resolvePath' | 'exists' | 'kindOf' | 'canonicalPath'>;

export function invalidOperatingDirectoryMessage(typed: string): string {
  return `Invalid operating directory: ${typed}`;
}

export function operatingDirectoryRoot(host: OperatingDirectoryHost, typed: string): string | null {
  const full = fullPathOf(typed, host);
  if (full === null) return null;
  return (host.kindOf?.(host.resolvePath(typed)) ?? 'directory') === 'directory' ? full : null;
}

export class OperatingDirectory {
  constructor(readonly root: string, private readonly host: OperatingDirectoryHost) {}

  outside(typed: string, tabbing = false): boolean {
    const full = fullPathOf(typed, this.host);
    if (full === null) return tabbing;
    return !full.startsWith(this.root) && !(tabbing && this.root.startsWith(full));
  }

  readRefusal(): string {
    return `Can't read file from outside of ${this.root}`;
  }

  writeRefusal(): string {
    return `Can't write outside of ${this.root}`;
  }
}
