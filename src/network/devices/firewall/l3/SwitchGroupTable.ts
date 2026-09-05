export type SwitchGroupType = 'switch' | 'hub';
export type IntraSwitchPolicy = 'implicit' | 'explicit';
export type SpanDirection = 'rx' | 'tx' | 'both';

export interface SwitchGroup {
  readonly name: string;
  readonly members: ReadonlySet<string>;
  readonly type: SwitchGroupType;
  readonly intraSwitchPolicy: IntraSwitchPolicy;
  readonly span: boolean;
  readonly spanDestination: string;
  readonly spanSources: ReadonlySet<string>;
  readonly spanDirection: SpanDirection;
}

export interface SwitchGroupPatch {
  readonly members: readonly string[];
  readonly type?: SwitchGroupType;
  readonly intraSwitchPolicy?: IntraSwitchPolicy;
  readonly span?: boolean;
  readonly spanDestination?: string;
  readonly spanSources?: readonly string[];
  readonly spanDirection?: SpanDirection;
}

export class SwitchGroupTable {
  private readonly groups = new Map<string, SwitchGroup>();

  set(name: string, patch: SwitchGroupPatch): void {
    this.groups.set(name, Object.freeze({
      name,
      members: new Set(patch.members),
      type: patch.type ?? 'switch',
      intraSwitchPolicy: patch.intraSwitchPolicy ?? 'implicit',
      span: patch.span ?? false,
      spanDestination: patch.spanDestination ?? '',
      spanSources: new Set(patch.spanSources ?? []),
      spanDirection: patch.spanDirection ?? 'both',
    }));
  }

  remove(name: string): boolean {
    return this.groups.delete(name);
  }

  names(): readonly string[] {
    return Object.freeze([...this.groups.keys()]);
  }

  members(name: string): readonly string[] {
    return Object.freeze([...(this.groups.get(name)?.members ?? [])]);
  }

  get(name: string): SwitchGroup | undefined {
    return this.groups.get(name);
  }

  groupOf(iface: string): SwitchGroup | undefined {
    for (const group of this.groups.values()) {
      if (group.members.has(iface)) return group;
    }
    return undefined;
  }

  sameGroup(left: string, right: string): boolean {
    const group = this.groupOf(left);
    return group !== undefined && group.members.has(right);
  }
}

export function spanCopies(
  group: SwitchGroup, source: string, direction: 'rx' | 'tx',
): boolean {
  if (!group.span || group.spanDestination.length === 0) return false;
  if (group.spanDestination === source) return false;
  if (group.spanDirection !== 'both' && group.spanDirection !== direction) return false;
  return group.spanSources.size === 0 || group.spanSources.has(source);
}
