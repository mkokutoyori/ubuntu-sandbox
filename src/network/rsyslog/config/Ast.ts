import type { PropertyDescriptor } from '../Properties';
import type { ObjectType } from './Lexer';

export type NameValue = string | string[];

export interface NvEntry {
  readonly name: string;
  readonly value: NameValue;
  used: boolean;
}

export class NvList {
  readonly entries: NvEntry[] = [];

  add(name: string, value: NameValue): void {
    this.entries.unshift({ name, value, used: false });
  }

  find(name: string): NvEntry | undefined {
    const wanted = name.toLowerCase();
    return this.entries.find((entry) => entry.name.toLowerCase() === wanted);
  }

  get isEmpty(): boolean {
    return this.entries.length === 0;
  }

  unused(): NvEntry[] {
    return this.entries.filter((entry) => !entry.used);
  }

  string(name: string): string | undefined {
    const entry = this.find(name);
    return entry === undefined || Array.isArray(entry.value) ? undefined : entry.value;
  }
}

export interface Location {
  readonly file: string;
  readonly line: number;
}

export interface ConfigObject {
  readonly type: ObjectType;
  readonly params: NvList;
  readonly location: Location;
  subObjects?: ConfigObject[];
  script?: Stmt[] | null;
}

export type BinaryOperator =
  | 'AND' | 'OR' | 'CMP_EQ' | 'CMP_NE' | 'CMP_LE' | 'CMP_GE' | 'CMP_LT' | 'CMP_GT' | 'CMP_CONTAINS' | 'CMP_CONTAINSI'
  | 'CMP_STARTSWITH' | 'CMP_STARTSWITHI' | 'CMP_ENDSWITH' | '&' | '+' | '-' | '*' | '/' | '%';

export type Expr =
  | { readonly k: 'num'; readonly value: number }
  | { readonly k: 'str'; readonly value: string }
  | { readonly k: 'arr'; readonly values: string[] }
  | { readonly k: 'var'; readonly name: string; readonly prop: PropertyDescriptor }
  | { readonly k: 'func'; readonly name: string; readonly args: Expr[] }
  | { readonly k: 'exists'; readonly name: string; readonly prop: PropertyDescriptor }
  | { readonly k: 'bin'; readonly op: BinaryOperator; readonly l: Expr; readonly r: Expr }
  | { readonly k: 'not'; readonly r: Expr }
  | { readonly k: 'neg'; readonly r: Expr };

export type PropertyFilterOperation = 'contains' | 'isequal' | 'isempty' | 'startswith' | 'endswith' | 'regex' | 'ereregex';

export type Stmt =
  | { readonly k: 'nop'; readonly printable?: string }
  | { readonly k: 'stop' }
  | { readonly k: 'act'; readonly action: unknown; readonly printable: string }
  | { readonly k: 'call'; readonly name: string }
  | { readonly k: 'callIndirect'; readonly expr: Expr }
  | { readonly k: 'if'; readonly expr: Expr; readonly then: Stmt[]; readonly else: Stmt[] | null }
  | { readonly k: 'foreach'; readonly variable: string; readonly collection: Expr; readonly body: Stmt[] }
  | { readonly k: 'set'; readonly variable: string; readonly expr: Expr; readonly reset: boolean }
  | { readonly k: 'unset'; readonly variable: string }
  | { readonly k: 'prifilt'; readonly printable: string; readonly mask: number[]; readonly then: Stmt[] }
  | {
    readonly k: 'propfilt'; readonly printable: string; readonly prop: PropertyDescriptor; readonly operation: PropertyFilterOperation;
    readonly negated: boolean; readonly value: string; readonly then: Stmt[];
  }
  | { readonly k: 'reloadLookupTable'; readonly args: Expr[] };
