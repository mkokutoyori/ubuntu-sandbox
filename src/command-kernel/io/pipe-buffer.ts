import { BrokenPipeError, PipeCapacityError } from "../errors";
import { InputStream, OutputStream } from "./types";

/** Garde-fou mémoire : le modèle séquentiel accumule tout le flux d'un
 *  étage avant que le suivant ne le lise — sans borne, un producteur
 *  prolixe dériverait silencieusement. */
export const PIPE_CAPACITY_DEFAULT = 8 * 1024 * 1024;

/** Tampon mémoire servant de tuyau entre deux commandes d'un pipeline. */
export class PipeBuffer implements InputStream, OutputStream {
  private chunks: string[] = [];
  private size = 0;
  private closed = false;

  constructor(private readonly capacity: number = PIPE_CAPACITY_DEFAULT) {}

  async write(chunk: string): Promise<void> {
    if (this.closed) throw new BrokenPipeError();
    this.size += chunk.length;
    if (this.size > this.capacity) throw new PipeCapacityError(this.capacity);
    this.chunks.push(chunk);
  }

  async close(): Promise<void> {
    this.closed = true;
  }

  async read(): Promise<string | null> {
    const chunk = this.chunks.shift();
    if (chunk === undefined) return null;
    this.size -= chunk.length;
    return chunk;
  }

  async readAll(): Promise<string> {
    const all = this.chunks.splice(0).join("");
    this.size = 0;
    return all;
  }
}
