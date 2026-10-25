/**
 * The YAML reader, scanner and parser in src/network/yaml are a port of libyaml 0.2.5 (reader.c, scanner.c, parser.c), which is what
 * rsyslog links for ratelimit() policy files.  The fixture was recorded by scripts/oracle/record_yaml_events.py: a hand-written corpus
 * covering every production and every error libyaml can raise, a seeded fuzz of fragment concatenations and mutated well-formed
 * documents, and documents that straddle libyaml's 16 KiB raw buffer.  For each document the real library's events (value, anchor, tag,
 * implicit flags, style, start and end marks) and its error (kind, problem, context, marks, or the reader's offset and value) are
 * compared here with this port's.
 */
import { describe, expect, it } from 'vitest';
import fixture from '../../support/oracle/yaml/libyaml-events.json';
import { parseYaml } from '@/network/yaml/YamlParser';
import type { YamlError, YamlEvent, YamlMark } from '@/network/yaml/YamlTypes';

interface RecordedCase {
  source: string;
  events: Array<Record<string, unknown>>;
}

const cases = (fixture as unknown as { cases: RecordedCase[] }).cases;

const triple = (mark: YamlMark): number[] => [mark.index, mark.line, mark.column];
const flag = (value: boolean): number => (value ? 1 : 0);

function project(event: YamlEvent): Record<string, unknown> {
  const marks = { s: triple(event.start), e: triple(event.end) };
  switch (event.type) {
    case 'stream-start':
    case 'stream-end':
    case 'sequence-end':
    case 'mapping-end':
      return { t: event.type, ...marks };
    case 'document-start':
      return {
        t: event.type,
        implicit: flag(event.implicit),
        version: event.version === null ? null : [event.version.major, event.version.minor],
        tags: event.tagDirectives.map((directive) => ({ handle: directive.handle, prefix: directive.prefix })),
        ...marks,
      };
    case 'document-end':
      return { t: event.type, implicit: flag(event.implicit), ...marks };
    case 'alias':
      return { t: event.type, anchor: event.anchor, ...marks };
    case 'scalar':
      return {
        t: event.type, value: event.value, anchor: event.anchor, tag: event.tag,
        plain: flag(event.plainImplicit), quoted: flag(event.quotedImplicit), style: event.style, ...marks,
      };
    case 'sequence-start':
    case 'mapping-start':
      return { t: event.type, anchor: event.anchor, tag: event.tag, implicit: flag(event.implicit), style: event.style, ...marks };
  }
}

function projectError(error: YamlError): Record<string, unknown> {
  const base: Record<string, unknown> = { t: 'error', kind: error.kind, problem: error.problem, context: error.context };
  if (error.kind === 'reader') return { ...base, offset: error.problemOffset, value: error.problemValue };
  const marks: Record<string, unknown> = { problemMark: triple(error.problemMark as YamlMark) };
  if (error.context !== null) marks.contextMark = triple(error.contextMark as YamlMark);
  return { ...base, ...marks };
}

function describeCase(source: string): string {
  return JSON.stringify(source.length > 60 ? `${source.slice(0, 57)}...` : source);
}

describe('YAML port against libyaml', () => {
  it('the fixture is a real corpus: valid documents, every error kind, and large inputs', () => {
    expect(cases.length).toBeGreaterThan(1000);
    const errors = cases.filter((entry) => entry.events[entry.events.length - 1].t === 'error');
    expect(new Set(errors.map((entry) => entry.events[entry.events.length - 1].kind))).toEqual(new Set(['reader', 'scanner', 'parser']));
    expect(cases.length - errors.length).toBeGreaterThan(400);
    expect(cases.some((entry) => entry.source.length > 16384)).toBe(true);
  });

  it('produces the same events, marks and errors as libyaml on every recorded document', () => {
    const divergences: string[] = [];
    for (const entry of cases) {
      const parsed = parseYaml(entry.source);
      const actual = parsed.events.map(project);
      if (parsed.error !== null) actual.push(projectError(parsed.error));
      const matches = JSON.stringify(actual) === JSON.stringify(entry.events);
      if (!matches) {
        const index = actual.findIndex((event, position) => JSON.stringify(event) !== JSON.stringify(entry.events[position]));
        divergences.push(`${describeCase(entry.source)} at event ${index}: expected ${JSON.stringify(entry.events[index])} got ${JSON.stringify(actual[index])}`);
      }
    }
    expect(divergences.slice(0, 15)).toEqual([]);
  });
});
