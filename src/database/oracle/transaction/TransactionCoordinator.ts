import type { StorageRow } from '../../engine/storage/BaseStorage';

export interface CommittedImageProvider {
  committedImage(schema: string, tableName: string): StorageRow[] | null;
}

export class TransactionCoordinator {
  private readonly writers = new Set<CommittedImageProvider>();

  registerWriter(w: CommittedImageProvider): void { this.writers.add(w); }
  unregisterWriter(w: CommittedImageProvider): void { this.writers.delete(w); }

  committedImageFor(
    reader: CommittedImageProvider, schema: string, tableName: string,
  ): StorageRow[] | null {
    for (const w of this.writers) {
      if (w === reader) continue;
      const img = w.committedImage(schema, tableName);
      if (img) return img;
    }
    return null;
  }
}
