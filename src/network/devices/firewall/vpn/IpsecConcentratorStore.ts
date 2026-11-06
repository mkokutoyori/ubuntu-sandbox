export interface IpsecConcentrator {
  readonly id: number;
  readonly name: string;
  readonly members: readonly string[];
  readonly srcCheck: boolean;
}

export class IpsecConcentratorStore {
  private readonly entries = new Map<number, IpsecConcentrator>();

  set(entry: IpsecConcentrator): void { this.entries.set(entry.id, entry); }
  remove(id: number): void { this.entries.delete(id); }
  all(): readonly IpsecConcentrator[] { return [...this.entries.values()]; }

  disablesSrcCheck(tunnelName: string): boolean {
    return this.all().some((entry) => !entry.srcCheck && entry.members.includes(tunnelName));
  }
}
