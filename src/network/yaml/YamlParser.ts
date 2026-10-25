import { YamlScanner, type YamlToken } from './YamlScanner';
import {
  YamlFailure,
  type CollectionStyle,
  type ScalarStyle,
  type YamlError,
  type YamlEvent,
  type YamlMark,
  type YamlParse,
  type YamlTagDirective,
  type YamlVersion,
} from './YamlTypes';

type State =
  | 'stream-start' | 'implicit-document-start' | 'document-start' | 'document-content' | 'document-end'
  | 'block-node' | 'block-node-or-indentless-sequence' | 'flow-node'
  | 'block-sequence-first-entry' | 'block-sequence-entry' | 'indentless-sequence-entry'
  | 'block-mapping-first-key' | 'block-mapping-key' | 'block-mapping-value'
  | 'flow-sequence-first-entry' | 'flow-sequence-entry'
  | 'flow-sequence-entry-mapping-key' | 'flow-sequence-entry-mapping-value' | 'flow-sequence-entry-mapping-end'
  | 'flow-mapping-first-key' | 'flow-mapping-key' | 'flow-mapping-value' | 'flow-mapping-empty-value'
  | 'end';

const DEFAULT_TAG_DIRECTIVES: readonly YamlTagDirective[] = [
  { handle: '!', prefix: '!' },
  { handle: '!!', prefix: 'tag:yaml.org,2002:' },
];

const SCALAR_IMPLICIT_TAG = '!';

export class YamlEventStream {
  private readonly scanner: YamlScanner;
  private state: State = 'stream-start';
  private readonly states: State[] = [];
  private readonly marks: YamlMark[] = [];
  private tagDirectives: YamlTagDirective[] = [];
  private failed = false;

  constructor(text: string) {
    this.scanner = new YamlScanner(text);
  }

  next(): YamlEvent | null {
    if (this.scanner.finished || this.failed || this.state === 'end') return null;
    try {
      return this.dispatch();
    } catch (error) {
      this.failed = true;
      throw error;
    }
  }

  private fail(problem: string, problemMark: YamlMark): never {
    throw new YamlFailure({ kind: 'parser', problem, context: null, contextMark: null, problemMark, problemOffset: null, problemValue: null });
  }

  private failInContext(context: string, contextMark: YamlMark, problem: string, problemMark: YamlMark): never {
    throw new YamlFailure({ kind: 'parser', problem, context, contextMark, problemMark, problemOffset: null, problemValue: null });
  }

  private dispatch(): YamlEvent {
    switch (this.state) {
      case 'stream-start': return this.streamStart();
      case 'implicit-document-start': return this.documentStart(true);
      case 'document-start': return this.documentStart(false);
      case 'document-content': return this.documentContent();
      case 'document-end': return this.documentEnd();
      case 'block-node': return this.node(true, false);
      case 'block-node-or-indentless-sequence': return this.node(true, true);
      case 'flow-node': return this.node(false, false);
      case 'block-sequence-first-entry': return this.blockSequenceEntry(true);
      case 'block-sequence-entry': return this.blockSequenceEntry(false);
      case 'indentless-sequence-entry': return this.indentlessSequenceEntry();
      case 'block-mapping-first-key': return this.blockMappingKey(true);
      case 'block-mapping-key': return this.blockMappingKey(false);
      case 'block-mapping-value': return this.blockMappingValue();
      case 'flow-sequence-first-entry': return this.flowSequenceEntry(true);
      case 'flow-sequence-entry': return this.flowSequenceEntry(false);
      case 'flow-sequence-entry-mapping-key': return this.flowSequenceEntryMappingKey();
      case 'flow-sequence-entry-mapping-value': return this.flowSequenceEntryMappingValue();
      case 'flow-sequence-entry-mapping-end': return this.flowSequenceEntryMappingEnd();
      case 'flow-mapping-first-key': return this.flowMappingKey(true);
      case 'flow-mapping-key': return this.flowMappingKey(false);
      case 'flow-mapping-value': return this.flowMappingValue(false);
      case 'flow-mapping-empty-value': return this.flowMappingValue(true);
      case 'end': throw new Error('unreachable parser state');
    }
  }

  private popState(): State {
    return this.states.pop() as State;
  }

  private streamStart(): YamlEvent {
    const token = this.scanner.peek();
    if (token.type !== 'stream-start') this.fail('did not find expected <stream-start>', token.start);
    this.state = 'implicit-document-start';
    this.scanner.skip();
    return { type: 'stream-start', start: token.start, end: token.start };
  }

  private documentStart(implicit: boolean): YamlEvent {
    let token = this.scanner.peek();
    if (!implicit) {
      while (token.type === 'document-end') {
        this.scanner.skip();
        token = this.scanner.peek();
      }
    }
    if (implicit && token.type !== 'stream-end' && token.type !== 'document-start'
      && token.type !== 'version-directive' && token.type !== 'tag-directive') {
      this.processDirectives();
      this.states.push('document-end');
      this.state = 'block-node';
      return { type: 'document-start', implicit: true, version: null, tagDirectives: [], start: token.start, end: token.start };
    }
    if (token.type !== 'stream-end') {
      const start = token.start;
      const { version, directives } = this.processDirectives();
      token = this.scanner.peek();
      if (token.type !== 'document-start') this.fail('did not find expected <document start>', token.start);
      this.states.push('document-end');
      this.state = 'document-content';
      const end = token.end;
      this.scanner.skip();
      return { type: 'document-start', implicit: false, version, tagDirectives: directives, start, end };
    }
    this.state = 'end';
    this.scanner.skip();
    return { type: 'stream-end', start: token.start, end: token.end };
  }

  private documentContent(): YamlEvent {
    const token = this.scanner.peek();
    if (token.type === 'version-directive' || token.type === 'tag-directive' || token.type === 'document-start'
      || token.type === 'document-end' || token.type === 'stream-end') {
      this.state = this.popState();
      return this.emptyScalar(token.start);
    }
    return this.node(true, false);
  }

  private documentEnd(): YamlEvent {
    const token = this.scanner.peek();
    let end = token.start;
    let implicit = true;
    if (token.type === 'document-end') {
      end = token.end;
      this.scanner.skip();
      implicit = false;
    }
    this.tagDirectives = [];
    this.state = 'document-start';
    return { type: 'document-end', implicit, start: token.start, end };
  }

  private resolveTag(handle: string, suffix: string, startMark: YamlMark, tagMark: YamlMark): string {
    if (handle === '') return suffix;
    const directive = this.tagDirectives.find((candidate) => candidate.handle === handle);
    if (directive === undefined) this.failInContext('while parsing a node', startMark, 'found undefined tag handle', tagMark);
    return directive.prefix + suffix;
  }

  private node(block: boolean, indentlessSequence: boolean): YamlEvent {
    let token = this.scanner.peek();
    if (token.type === 'alias') {
      this.state = this.popState();
      this.scanner.skip();
      return { type: 'alias', anchor: token.value, start: token.start, end: token.end };
    }
    let anchor: string | null = null;
    let tagHandle: string | null = null;
    let tagSuffix = '';
    let start = token.start;
    let end = token.start;
    let tagMark = token.start;
    if (token.type === 'anchor') {
      anchor = token.value;
      start = token.start;
      end = token.end;
      this.scanner.skip();
      token = this.scanner.peek();
      if (token.type === 'tag') {
        tagHandle = token.handle;
        tagSuffix = token.suffix;
        tagMark = token.start;
        end = token.end;
        this.scanner.skip();
        token = this.scanner.peek();
      }
    } else if (token.type === 'tag') {
      tagHandle = token.handle;
      tagSuffix = token.suffix;
      start = tagMark = token.start;
      end = token.end;
      this.scanner.skip();
      token = this.scanner.peek();
      if (token.type === 'anchor') {
        anchor = token.value;
        end = token.end;
        this.scanner.skip();
        token = this.scanner.peek();
      }
    }
    const tag = tagHandle === null ? null : this.resolveTag(tagHandle, tagSuffix, start, tagMark);
    const implicit = tag === null || tag === '';
    if (indentlessSequence && token.type === 'block-entry') {
      this.state = 'indentless-sequence-entry';
      return this.collectionStart('sequence-start', anchor, tag, implicit, 'block', start, token.end);
    }
    switch (token.type) {
      case 'scalar': {
        const plainImplicit = (token.style === 'plain' && tag === null) || tag === SCALAR_IMPLICIT_TAG;
        const quotedImplicit = !plainImplicit && tag === null;
        this.state = this.popState();
        this.scanner.skip();
        return {
          type: 'scalar', anchor, tag, value: token.value, plainImplicit, quotedImplicit, style: token.style, start, end: token.end,
        };
      }
      case 'flow-sequence-start':
        this.state = 'flow-sequence-first-entry';
        return this.collectionStart('sequence-start', anchor, tag, implicit, 'flow', start, token.end);
      case 'flow-mapping-start':
        this.state = 'flow-mapping-first-key';
        return this.collectionStart('mapping-start', anchor, tag, implicit, 'flow', start, token.end);
      case 'block-sequence-start':
        if (block) {
          this.state = 'block-sequence-first-entry';
          return this.collectionStart('sequence-start', anchor, tag, implicit, 'block', start, token.end);
        }
        break;
      case 'block-mapping-start':
        if (block) {
          this.state = 'block-mapping-first-key';
          return this.collectionStart('mapping-start', anchor, tag, implicit, 'block', start, token.end);
        }
        break;
      default:
        break;
    }
    if (anchor !== null || tag !== null) {
      this.state = this.popState();
      return {
        type: 'scalar', anchor, tag, value: '', plainImplicit: implicit, quotedImplicit: false, style: 'plain', start, end,
      };
    }
    return this.failInContext(block ? 'while parsing a block node' : 'while parsing a flow node', start, 'did not find expected node content', token.start);
  }

  private collectionStart(
    type: 'sequence-start' | 'mapping-start',
    anchor: string | null,
    tag: string | null,
    implicit: boolean,
    style: CollectionStyle,
    start: YamlMark,
    end: YamlMark,
  ): YamlEvent {
    return { type, anchor, tag, implicit, style, start, end };
  }

  private blockSequenceEntry(first: boolean): YamlEvent {
    if (first) {
      this.marks.push(this.scanner.peek().start);
      this.scanner.skip();
    }
    let token = this.scanner.peek();
    if (token.type === 'block-entry') {
      const mark = token.end;
      this.scanner.skip();
      token = this.scanner.peek();
      if (token.type !== 'block-entry' && token.type !== 'block-end') {
        this.states.push('block-sequence-entry');
        return this.node(true, false);
      }
      this.state = 'block-sequence-entry';
      return this.emptyScalar(mark);
    }
    if (token.type === 'block-end') {
      this.state = this.popState();
      this.marks.pop();
      this.scanner.skip();
      return { type: 'sequence-end', start: token.start, end: token.end };
    }
    return this.failInContext('while parsing a block collection', this.marks.pop() as YamlMark, "did not find expected '-' indicator", token.start);
  }

  private indentlessSequenceEntry(): YamlEvent {
    let token = this.scanner.peek();
    if (token.type === 'block-entry') {
      const mark = token.end;
      this.scanner.skip();
      token = this.scanner.peek();
      if (token.type !== 'block-entry' && token.type !== 'key' && token.type !== 'value' && token.type !== 'block-end') {
        this.states.push('indentless-sequence-entry');
        return this.node(true, false);
      }
      this.state = 'indentless-sequence-entry';
      return this.emptyScalar(mark);
    }
    this.state = this.popState();
    return { type: 'sequence-end', start: token.start, end: token.start };
  }

  private blockMappingKey(first: boolean): YamlEvent {
    if (first) {
      this.marks.push(this.scanner.peek().start);
      this.scanner.skip();
    }
    let token = this.scanner.peek();
    if (token.type === 'key') {
      const mark = token.end;
      this.scanner.skip();
      token = this.scanner.peek();
      if (token.type !== 'key' && token.type !== 'value' && token.type !== 'block-end') {
        this.states.push('block-mapping-value');
        return this.node(true, true);
      }
      this.state = 'block-mapping-value';
      return this.emptyScalar(mark);
    }
    if (token.type === 'block-end') {
      this.state = this.popState();
      this.marks.pop();
      this.scanner.skip();
      return { type: 'mapping-end', start: token.start, end: token.end };
    }
    return this.failInContext('while parsing a block mapping', this.marks.pop() as YamlMark, 'did not find expected key', token.start);
  }

  private blockMappingValue(): YamlEvent {
    let token = this.scanner.peek();
    if (token.type === 'value') {
      const mark = token.end;
      this.scanner.skip();
      token = this.scanner.peek();
      if (token.type !== 'key' && token.type !== 'value' && token.type !== 'block-end') {
        this.states.push('block-mapping-key');
        return this.node(true, true);
      }
      this.state = 'block-mapping-key';
      return this.emptyScalar(mark);
    }
    this.state = 'block-mapping-key';
    return this.emptyScalar(token.start);
  }

  private flowSequenceEntry(first: boolean): YamlEvent {
    if (first) {
      this.marks.push(this.scanner.peek().start);
      this.scanner.skip();
    }
    let token = this.scanner.peek();
    if (token.type !== 'flow-sequence-end') {
      if (!first) {
        if (token.type === 'flow-entry') {
          this.scanner.skip();
          token = this.scanner.peek();
        } else {
          return this.failInContext('while parsing a flow sequence', this.marks.pop() as YamlMark, "did not find expected ',' or ']'", token.start);
        }
      }
      if (token.type === 'key') {
        this.state = 'flow-sequence-entry-mapping-key';
        this.scanner.skip();
        return { type: 'mapping-start', anchor: null, tag: null, implicit: true, style: 'flow', start: token.start, end: token.end };
      }
      if (token.type !== 'flow-sequence-end') {
        this.states.push('flow-sequence-entry');
        return this.node(false, false);
      }
    }
    this.state = this.popState();
    this.marks.pop();
    this.scanner.skip();
    return { type: 'sequence-end', start: token.start, end: token.end };
  }

  private flowSequenceEntryMappingKey(): YamlEvent {
    const token = this.scanner.peek();
    if (token.type !== 'value' && token.type !== 'flow-entry' && token.type !== 'flow-sequence-end') {
      this.states.push('flow-sequence-entry-mapping-value');
      return this.node(false, false);
    }
    const mark = token.end;
    this.scanner.skip();
    this.state = 'flow-sequence-entry-mapping-value';
    return this.emptyScalar(mark);
  }

  private flowSequenceEntryMappingValue(): YamlEvent {
    let token = this.scanner.peek();
    if (token.type === 'value') {
      this.scanner.skip();
      token = this.scanner.peek();
      if (token.type !== 'flow-entry' && token.type !== 'flow-sequence-end') {
        this.states.push('flow-sequence-entry-mapping-end');
        return this.node(false, false);
      }
    }
    this.state = 'flow-sequence-entry-mapping-end';
    return this.emptyScalar(token.start);
  }

  private flowSequenceEntryMappingEnd(): YamlEvent {
    const token = this.scanner.peek();
    this.state = 'flow-sequence-entry';
    return { type: 'mapping-end', start: token.start, end: token.start };
  }

  private flowMappingKey(first: boolean): YamlEvent {
    if (first) {
      this.marks.push(this.scanner.peek().start);
      this.scanner.skip();
    }
    let token = this.scanner.peek();
    if (token.type !== 'flow-mapping-end') {
      if (!first) {
        if (token.type === 'flow-entry') {
          this.scanner.skip();
          token = this.scanner.peek();
        } else {
          return this.failInContext('while parsing a flow mapping', this.marks.pop() as YamlMark, "did not find expected ',' or '}'", token.start);
        }
      }
      if (token.type === 'key') {
        this.scanner.skip();
        token = this.scanner.peek();
        if (token.type !== 'value' && token.type !== 'flow-entry' && token.type !== 'flow-mapping-end') {
          this.states.push('flow-mapping-value');
          return this.node(false, false);
        }
        this.state = 'flow-mapping-value';
        return this.emptyScalar(token.start);
      }
      if (token.type !== 'flow-mapping-end') {
        this.states.push('flow-mapping-empty-value');
        return this.node(false, false);
      }
    }
    this.state = this.popState();
    this.marks.pop();
    this.scanner.skip();
    return { type: 'mapping-end', start: token.start, end: token.end };
  }

  private flowMappingValue(empty: boolean): YamlEvent {
    let token = this.scanner.peek();
    if (empty) {
      this.state = 'flow-mapping-key';
      return this.emptyScalar(token.start);
    }
    if (token.type === 'value') {
      this.scanner.skip();
      token = this.scanner.peek();
      if (token.type !== 'flow-entry' && token.type !== 'flow-mapping-end') {
        this.states.push('flow-mapping-key');
        return this.node(false, false);
      }
    }
    this.state = 'flow-mapping-key';
    return this.emptyScalar(token.start);
  }

  private emptyScalar(mark: YamlMark): YamlEvent {
    return {
      type: 'scalar', anchor: null, tag: null, value: '', plainImplicit: true, quotedImplicit: false, style: 'plain', start: mark, end: mark,
    };
  }

  private processDirectives(): { version: YamlVersion | null; directives: YamlTagDirective[] } {
    let version: YamlVersion | null = null;
    const declared: YamlTagDirective[] = [];
    let token: YamlToken = this.scanner.peek();
    while (token.type === 'version-directive' || token.type === 'tag-directive') {
      if (token.type === 'version-directive') {
        if (version !== null) this.fail('found duplicate %YAML directive', token.start);
        if (token.major !== 1 || (token.minor !== 1 && token.minor !== 2)) this.fail('found incompatible YAML document', token.start);
        version = { major: token.major, minor: token.minor };
      } else {
        const directive = { handle: token.handle, prefix: token.prefix };
        this.appendTagDirective(directive, false, token.start);
        declared.push(directive);
      }
      this.scanner.skip();
      token = this.scanner.peek();
    }
    for (const directive of DEFAULT_TAG_DIRECTIVES) this.appendTagDirective(directive, true, token.start);
    return { version, directives: declared };
  }

  private appendTagDirective(directive: YamlTagDirective, allowDuplicates: boolean, mark: YamlMark): void {
    if (this.tagDirectives.some((existing) => existing.handle === directive.handle)) {
      if (allowDuplicates) return;
      this.fail('found duplicate %TAG directive', mark);
    }
    this.tagDirectives.push(directive);
  }
}

export function parseYaml(text: string): YamlParse {
  const events: YamlEvent[] = [];
  const stream = new YamlEventStream(text);
  try {
    for (let event = stream.next(); event !== null; event = stream.next()) events.push(event);
    return { events, error: null };
  } catch (error) {
    if (error instanceof YamlFailure) return { events, error: error.error satisfies YamlError };
    throw error;
  }
}
