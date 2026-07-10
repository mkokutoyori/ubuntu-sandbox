/** Flux d'entrée/sortie génériques (pour supporter pipes et redirections). */

export interface InputStream {
  read(): Promise<string | null>; // null = EOF
  readAll(): Promise<string>;
}

export interface OutputStream {
  write(chunk: string): Promise<void>;
  close(): Promise<void>;
}

export interface CommandIO {
  readonly stdin: InputStream;
  readonly stdout: OutputStream;
  readonly stderr: OutputStream;
}
