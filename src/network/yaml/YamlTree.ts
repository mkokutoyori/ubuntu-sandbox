import { parseYaml } from './YamlParser';
import type { YamlError, YamlEvent, YamlMark } from './YamlTypes';

export interface YamlLocation {
  readonly file: string;
  readonly line: number;
  readonly column: number;
}

export interface YamlScalar {
  readonly kind: 'scalar';
  readonly value: string;
  readonly location: YamlLocation;
}

export interface YamlSequence {
  readonly kind: 'sequence';
  readonly items: readonly YamlNode[];
  readonly location: YamlLocation;
}

export interface YamlEntry {
  readonly key: YamlScalar;
  readonly value: YamlNode;
}

export interface YamlMapping {
  readonly kind: 'mapping';
  readonly entries: readonly YamlEntry[];
  readonly location: YamlLocation;
}

export type YamlNode = YamlScalar | YamlSequence | YamlMapping;

export interface YamlDocument {
  readonly root: YamlNode | null;
  readonly error: YamlError | null;
}

type CollectionStart = Extract<YamlEvent, { type: 'sequence-start' | 'mapping-start' }>;

class TreeBuilder {
  private position = 0;
  private readonly anchors = new Map<string, YamlNode>();

  constructor(private readonly events: readonly YamlEvent[], private readonly file: string) {}

  firstDocument(): YamlNode | null {
    while (this.position < this.events.length && this.events[this.position].type !== 'document-start') this.position++;
    if (this.position >= this.events.length) return null;
    this.position++;
    return this.node();
  }

  private locate(mark: YamlMark): YamlLocation {
    return { file: this.file, line: mark.line, column: mark.column };
  }

  private node(): YamlNode | null {
    const event = this.events[this.position++];
    if (event === undefined) return null;
    if (event.type === 'scalar') return this.remember(event.anchor, { kind: 'scalar', value: event.value, location: this.locate(event.start) });
    if (event.type === 'alias') return this.anchors.get(event.anchor) ?? null;
    if (event.type === 'sequence-start') return this.sequence(event);
    if (event.type === 'mapping-start') return this.mapping(event);
    return null;
  }

  private remember(anchor: string | null, node: YamlNode): YamlNode {
    if (anchor !== null) this.anchors.set(anchor, node);
    return node;
  }

  private sequence(start: CollectionStart): YamlNode {
    const items: YamlNode[] = [];
    const node: YamlSequence = { kind: 'sequence', items, location: this.locate(start.start) };
    this.remember(start.anchor, node);
    while (this.position < this.events.length && this.events[this.position].type !== 'sequence-end') {
      const item = this.node();
      if (item !== null) items.push(item);
    }
    this.position++;
    return node;
  }

  private mapping(start: CollectionStart): YamlNode {
    const entries: YamlEntry[] = [];
    const node: YamlMapping = { kind: 'mapping', entries, location: this.locate(start.start) };
    this.remember(start.anchor, node);
    while (this.position < this.events.length && this.events[this.position].type !== 'mapping-end') {
      const key = this.node();
      const value = this.node();
      if (key !== null && key.kind === 'scalar' && value !== null) entries.push({ key, value });
    }
    this.position++;
    return node;
  }
}

export function loadYaml(text: string, file: string): YamlDocument {
  const parsed = parseYaml(text);
  if (parsed.error !== null) return { root: null, error: parsed.error };
  return { root: new TreeBuilder(parsed.events, file).firstDocument(), error: null };
}

export function entryOf(mapping: YamlMapping, key: string): YamlEntry | undefined {
  for (let index = mapping.entries.length - 1; index >= 0; index--) {
    if (mapping.entries[index].key.value === key) return mapping.entries[index];
  }
  return undefined;
}

export function mergeYaml(base: YamlNode, overlay: YamlNode): YamlNode {
  if (base.kind === 'mapping' && overlay.kind === 'mapping') {
    const entries: YamlEntry[] = [...base.entries];
    for (const entry of overlay.entries) {
      const at = entries.findIndex((existing) => existing.key.value === entry.key.value);
      entries[at >= 0 ? at : entries.length] = at >= 0 ? { key: entries[at].key, value: mergeYaml(entries[at].value, entry.value) } : entry;
    }
    return { kind: 'mapping', entries, location: base.location };
  }
  if (base.kind === 'sequence' && overlay.kind === 'sequence') {
    return { kind: 'sequence', items: [...base.items, ...overlay.items], location: base.location };
  }
  return overlay;
}
