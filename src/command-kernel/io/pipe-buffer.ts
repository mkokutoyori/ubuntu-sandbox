import { InputStream, OutputStream } from "./types";

/** Tampon mémoire servant de tuyau entre deux commandes d'un pipeline. */
export class PipeBuffer implements InputStream, OutputStream {
  private chunks: string[] = [];
  private closed = false;

  async write(chunk: string): Promise<void> {
    if (this.closed) throw new Error("pipe fermé");
    this.chunks.push(chunk);
  }

  async close(): Promise<void> {
    this.closed = true;
  }

  async read(): Promise<string | null> {
    return this.chunks.shift() ?? (this.closed ? null : "");
  }

  async readAll(): Promise<string> {
    return this.chunks.splice(0).join("");
  }
}
