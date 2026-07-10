/** Erreurs à codes de sortie (conventions shell). */

export class ShellError extends Error {
  constructor(
    message: string,
    public readonly exitCode: number,
  ) {
    super(message);
    this.name = new.target.name;
  }
}

export class UsageError extends ShellError {
  constructor(message: string) {
    super(message, 2);
  }
}

export class PermissionError extends ShellError {
  constructor(message: string) {
    super(message, 126);
  }
}

export class CommandNotFoundError extends ShellError {
  constructor(name: string) {
    super(`commande introuvable : ${name}`, 127);
  }
}

export type FileSystemErrorCode = "ENOENT" | "EACCES" | "ENOTDIR" | "EISDIR" | "EEXIST" | "ENOTEMPTY";

export class FileSystemError extends ShellError {
  constructor(
    public readonly path: string,
    public readonly code: FileSystemErrorCode,
    message: string,
    exitCode = 1,
  ) {
    super(message, exitCode);
  }
}
