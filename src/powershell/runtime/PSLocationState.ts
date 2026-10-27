const HISTORY_CAPACITY = 20;
export const DRIVE_QUALIFIER = /^([A-Za-z][A-Za-z0-9_]*):(?!:)/;
export const PROVIDER_QUALIFIER = /^[^:\\/]+(?:\\[^:\\/]+)*::/;

export const providerSegments = (path: string): string[] => path.split(/[\\/]/);

export function joinProviderPath(drive: string, segments: readonly string[]): string {
  const kept: string[] = [];
  for (const segment of segments) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') kept.pop();
    else kept.push(segment);
  }
  return kept.length === 0 ? `${drive}:\\` : `${drive}:\\${kept.join('\\')}`;
}

export class PSLocationState {
  foreign: string | null = null;
  defaultStack = '';

  resolve(typed: string): string | null {
    const here = this.foreign;
    if (here === null || DRIVE_QUALIFIER.test(typed) || PROVIDER_QUALIFIER.test(typed) || typed.startsWith('~')) return null;
    const drive = DRIVE_QUALIFIER.exec(here)?.[1];
    if (drive === undefined) return null;
    const base = /^[\\/]/.test(typed) ? [] : providerSegments(here.replace(DRIVE_QUALIFIER, ''));
    return joinProviderPath(drive, [...base, ...providerSegments(typed)]);
  }

  private readonly lastByDrive = new Map<string, string>();
  private readonly lastByProvider = new Map<string, string>();
  private readonly stacks = new Map<string, string[]>();
  private readonly undoStack: string[] = [];
  private readonly redoStack: string[] = [];

  remember(drive: string, path: string): void {
    this.lastByDrive.set(drive.toUpperCase(), path);
  }

  remembered(drive: string): string | null {
    return this.lastByDrive.get(drive.toUpperCase()) ?? null;
  }

  enter(provider: string, drive: string, path: string): void {
    this.foreign = path;
    this.remember(drive, path);
    this.lastByProvider.set(provider, path);
  }

  lastOnProvider(provider: string): string | null {
    return this.lastByProvider.get(provider) ?? null;
  }

  push(stackName: string, path: string): void {
    const key = stackName.toLowerCase();
    const stack = this.stacks.get(key) ?? [];
    stack.push(path);
    this.stacks.set(key, stack);
  }

  pop(stackName: string): string | null {
    const key = stackName.toLowerCase();
    const stack = this.stacks.get(key);
    const path = stack?.pop() ?? null;
    if (stack !== undefined && stack.length === 0 && key !== '') this.stacks.delete(key);
    return path;
  }

  hasStack(stackName: string): boolean {
    return stackName === '' || this.stacks.has(stackName.toLowerCase());
  }

  entries(stackName: string): string[] {
    return [...(this.stacks.get(stackName.toLowerCase()) ?? [])].reverse();
  }

  record(path: string): void {
    this.undoStack.push(path);
    if (this.undoStack.length > HISTORY_CAPACITY) this.undoStack.shift();
    this.redoStack.length = 0;
  }

  undo(current: string): string | null {
    const previous = this.undoStack.pop() ?? null;
    if (previous !== null) this.redoStack.push(current);
    return previous;
  }

  redo(current: string): string | null {
    const next = this.redoStack.pop() ?? null;
    if (next !== null) this.undoStack.push(current);
    return next;
  }

  canUndo(): boolean {
    return this.undoStack.length > 0;
  }

  canRedo(): boolean {
    return this.redoStack.length > 0;
  }
}
