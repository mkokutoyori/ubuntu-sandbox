export interface StringNode {
  str: string;
  key: string | null;
  hits: number;
}

export class StringList {
  readonly nodes: StringNode[] = [];

  get count(): number {
    return this.nodes.length;
  }

  append(node: StringNode): void {
    this.nodes.push(node);
  }

  addIfUnique(str: string | null): number {
    if (str === null) return -1;
    const existing = this.nodes.find((n) => n.str === str);
    if (existing) {
      existing.hits++;
      return 0;
    }
    this.nodes.push({ str, key: null, hits: 1 });
    return 1;
  }

  sortByHits(): void {
    if (this.nodes.length <= 1) return;
    const ordered = this.nodes.map((node, index) => ({ node, index }));
    ordered.sort((a, b) => b.node.hits - a.node.hits || a.index - b.index);
    this.nodes.splice(0, this.nodes.length, ...ordered.map((entry) => entry.node));
  }
}

export interface IntNode {
  num: number;
  hits: number;
}

export class IntList {
  readonly nodes: IntNode[] = [];

  get count(): number {
    return this.nodes.length;
  }

  addIfUnique(num: number): number {
    for (let i = 0; i < this.nodes.length; i++) {
      const node = this.nodes[i];
      if (node.num === num) {
        node.hits++;
        return 0;
      }
      if (num < node.num) {
        this.nodes.splice(i, 0, { num, hits: 1 });
        return 1;
      }
    }
    this.nodes.push({ num, hits: 1 });
    return 1;
  }

  sortByHits(): void {
    if (this.nodes.length <= 1) return;
    const ordered = this.nodes.map((node, index) => ({ node, index }));
    ordered.sort((a, b) => b.node.hits - a.node.hits || a.index - b.index);
    this.nodes.splice(0, this.nodes.length, ...ordered.map((entry) => entry.node));
  }
}

export type AvcResult = 0 | 1 | 2;
export const AVC_UNSET: AvcResult = 0;
export const AVC_DENIED: AvcResult = 1;
export const AVC_GRANTED: AvcResult = 2;

export interface AvcNode {
  scontext: string | null;
  tcontext: string | null;
  avcResult: AvcResult;
  avcPerm: string | null;
  avcClass: string | null;
}

export function newAvcNode(): AvcNode {
  return { scontext: null, tcontext: null, avcResult: AVC_UNSET, avcPerm: null, avcClass: null };
}
