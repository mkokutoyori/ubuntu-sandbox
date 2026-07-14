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
  constructor(public readonly commandName: string) {
    super(`commande introuvable : ${commandName}`, 127);
  }
}

/** 141 = 128 + SIGPIPE(13) : écriture vers un pipe dont le lecteur est parti. */
export class BrokenPipeError extends ShellError {
  constructor(message = "pipe fermé") {
    super(message, 141);
  }
}

export class PipeCapacityError extends ShellError {
  constructor(public readonly capacity: number) {
    super(`pipe : capacité maximale dépassée (${capacity} caractères)`, 1);
  }
}

export class InteractionUnavailableError extends ShellError {
  constructor(commandName: string) {
    super(`${commandName} : saisie interactive impossible dans ce contexte`, 1);
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
