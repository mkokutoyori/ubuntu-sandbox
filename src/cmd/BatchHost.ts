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
  write(absolutePath: string, content: string, append: boolean): string | null;
  list(absolutePath: string): DirectoryEntry[];
}

export interface BatchHost {
  readonly env: BatchEnvironment;
  readonly fs: BatchFileSystem;
  cwd(): string;
  enterDirectory(target: string): string | null;
  directoryStack(): string[];
  attachNetworkPath?(target: string, depth: number): { path: string } | { error: string } | null;
  releaseTemporaryDrives?(depth: number): void;
  captureLocation(): () => void;
  prompt(): string;
  formattedDate(): string;
  formattedTime(): string;
  random(): number;
  runCommand(line: string, stdin?: string, inScript?: boolean): Promise<CommandOutcome>;
  readInputLine?(prompt: string): Promise<string | null>;
  inputIsInteractive?(): boolean;
}
