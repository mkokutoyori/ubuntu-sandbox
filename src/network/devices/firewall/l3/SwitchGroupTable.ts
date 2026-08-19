export class SwitchGroupTable {
  private readonly groups = new Map<string, ReadonlySet<string>>();

  set(name: string, members: readonly string[]): void {
    this.groups.set(name, new Set(members));
  }

  remove(name: string): boolean {
    return this.groups.delete(name);
  }

  names(): readonly string[] {
    return Object.freeze([...this.groups.keys()]);
  }

  members(name: string): readonly string[] {
    return Object.freeze([...(this.groups.get(name) ?? [])]);
  }

  sameGroup(left: string, right: string): boolean {
    for (const members of this.groups.values()) {
      if (members.has(left) && members.has(right)) return true;
    }
    return false;
  }
}
