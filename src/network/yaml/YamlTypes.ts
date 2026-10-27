export interface YamlMark {
  readonly index: number;
  readonly line: number;
  readonly column: number;
}

export type YamlErrorKind = 'reader' | 'scanner' | 'parser';

export interface YamlError {
  readonly kind: YamlErrorKind;
  readonly problem: string;
  readonly context: string | null;
  readonly contextMark: YamlMark | null;
  readonly problemMark: YamlMark | null;
  readonly problemOffset: number | null;
  readonly problemValue: number | null;
}

export class YamlFailure extends Error {
  constructor(readonly error: YamlError) {
    super(error.problem);
  }
}

export type ScalarStyle = 'plain' | 'single-quoted' | 'double-quoted' | 'literal' | 'folded';
export type CollectionStyle = 'block' | 'flow';

export interface YamlVersion {
  readonly major: number;
  readonly minor: number;
}

export interface YamlTagDirective {
  readonly handle: string;
  readonly prefix: string;
}

interface Located {
  readonly start: YamlMark;
  readonly end: YamlMark;
}

export type YamlEvent =
  | (Located & { readonly type: 'stream-start' })
  | (Located & { readonly type: 'stream-end' })
  | (Located & {
    readonly type: 'document-start';
    readonly implicit: boolean;
    readonly version: YamlVersion | null;
    readonly tagDirectives: readonly YamlTagDirective[];
  })
  | (Located & { readonly type: 'document-end'; readonly implicit: boolean })
  | (Located & { readonly type: 'alias'; readonly anchor: string })
  | (Located & {
    readonly type: 'scalar';
    readonly anchor: string | null;
    readonly tag: string | null;
    readonly value: string;
    readonly plainImplicit: boolean;
    readonly quotedImplicit: boolean;
    readonly style: ScalarStyle;
  })
  | (Located & {
    readonly type: 'sequence-start' | 'mapping-start';
    readonly anchor: string | null;
    readonly tag: string | null;
    readonly implicit: boolean;
    readonly style: CollectionStyle;
  })
  | (Located & { readonly type: 'sequence-end' | 'mapping-end' });

export interface YamlParse {
  readonly events: YamlEvent[];
  readonly error: YamlError | null;
}
