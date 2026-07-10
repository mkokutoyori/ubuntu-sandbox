import { FileSystemApi } from "../machine/types";
import { OutputStream } from "./types";

/**
 * Adapte une redirection (`>` / `>>`) en OutputStream : les écritures
 * s'accumulent en mémoire et sont écrites une seule fois sur `close()`,
 * pour que `>` tronque le fichier une seule fois même si la commande
 * appelle `write()` plusieurs fois.
 */
export class FileOutputStream implements OutputStream {
  private buffer = "";
  private flushed = false;

  constructor(
    private readonly fs: FileSystemApi,
    private readonly path: string,
    private readonly append: boolean,
  ) {}

  async write(chunk: string): Promise<void> {
    this.buffer += chunk;
  }

  async close(): Promise<void> {
    if (this.flushed) return;
    this.flushed = true;
    await this.fs.writeFile(this.path, this.buffer, this.append);
    this.buffer = "";
  }
}
