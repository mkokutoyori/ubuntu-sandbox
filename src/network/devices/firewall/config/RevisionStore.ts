export const MAX_CONFIG_REVISIONS = 20;

export interface ConfigRevision {
  readonly id: number;
  readonly at: number;
  readonly admin: string;
  readonly firmware: string;
  readonly comment: string;
  readonly text: string;
}

export interface RevisionDraft {
  readonly admin: string;
  readonly firmware: string;
  readonly comment: string;
  readonly text: string;
}

export interface RevisionStoreOptions {
  readonly now: () => number;
  readonly limit?: number;
}

export class RevisionStore {
  private readonly revisions: ConfigRevision[] = [];
  private readonly now: () => number;
  private readonly limit: number;
  private nextId = 1;

  constructor(options: RevisionStoreOptions) {
    this.now = options.now;
    this.limit = Math.max(1, options.limit ?? MAX_CONFIG_REVISIONS);
  }

  record(draft: RevisionDraft): ConfigRevision {
    const revision: ConfigRevision = Object.freeze({
      id: this.nextId++,
      at: this.now(),
      admin: draft.admin,
      firmware: draft.firmware,
      comment: draft.comment,
      text: draft.text,
    });
    this.revisions.push(revision);
    while (this.revisions.length > this.limit) this.revisions.shift();
    return revision;
  }

  list(): readonly ConfigRevision[] {
    return Object.freeze([...this.revisions]);
  }

  get(id: number): ConfigRevision | undefined {
    return this.revisions.find(revision => revision.id === id);
  }

  remove(id: number): boolean {
    const index = this.revisions.findIndex(revision => revision.id === id);
    if (index < 0) return false;
    this.revisions.splice(index, 1);
    return true;
  }

  clear(): void {
    this.revisions.length = 0;
  }
}
