export interface CommandOutcome {
  readonly output: string;
  readonly exitCode: number;
  readonly notRecognized?: boolean;
}

export interface DirectoryEntry {
  readonly name: string;
  readonly isDirectory: boolean;
  readonly size: number;
  readonly written: Date;
  readonly attributes: ReadonlySet<string>;
}

export interface BatchEnvironment {
  get(name: string): string | undefined;
  set(name: string, value: string): void;
  unset(name: string): void;
  names(): string[];
}

export interface BatchFileSystem {
  normalize(path: string, base: string): string;
  exists(absolutePath: string): boolean;
  isDirectory(absolutePath: string): boolean;
  read(absolutePath: string): string | null;
  write(absolutePath: string, content: string, append: boolean): boolean;
  list(absolutePath: string): DirectoryEntry[];
}

export interface BatchHost {
  readonly env: BatchEnvironment;
  readonly fs: BatchFileSystem;
  cwd(): string;
  setCwd(absolutePath: string): void;
  formattedDate(): string;
  formattedTime(): string;
  random(): number;
  runCommand(line: string, stdin?: string): Promise<CommandOutcome>;
  readInputLine?(prompt: string): Promise<string | null>;
}
