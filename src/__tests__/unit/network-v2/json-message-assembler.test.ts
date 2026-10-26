import { describe, it, expect } from 'vitest';
import { JsonMessageAssembler } from '@/network/devices/windows/server/JsonMessageAssembler';

const encode = (message: Record<string, unknown>): string => JSON.stringify(message);

function chunked(text: string, size: number): string[] {
  const pieces: string[] = [];
  for (let at = 0; at < text.length; at += size) pieces.push(text.slice(at, at + size));
  return pieces;
}

function collect(assembler: JsonMessageAssembler, pieces: string[]): Array<Record<string, unknown>> {
  return pieces.flatMap(piece => assembler.push(piece));
}

describe('JsonMessageAssembler', () => {
  it('returns an object that arrives whole', () => {
    expect(new JsonMessageAssembler().push(encode({ op: 'negotiate' }))).toEqual([{ op: 'negotiate' }]);
  });

  it('returns nothing until the closing brace has arrived', () => {
    const assembler = new JsonMessageAssembler();
    expect(assembler.push('{"op":"run","line":"get')).toEqual([]);
    expect(assembler.push('-date"')).toEqual([]);
    expect(assembler.push('}')).toEqual([{ op: 'run', line: 'get-date' }]);
  });

  it.each([1, 2, 3, 5, 7, 11])('puts back together an object cut every %i characters', (size) => {
    const message = { op: 'run', line: 'say "hi" \\ {x} }{', nested: { list: [1, { deep: '}' }], text: 'a\\"b' } };
    expect(collect(new JsonMessageAssembler(), chunked(encode(message), size))).toEqual([message]);
  });

  it('returns every object of a chunk that carries several, in order', () => {
    const first = { op: 'a' };
    const second = { op: 'b', value: { inner: 1 } };
    const third = { op: 'c' };
    expect(new JsonMessageAssembler().push(encode(first) + encode(second) + encode(third))).toEqual([first, second, third]);
  });

  it('returns the objects that complete in a chunk and keeps the start of the next one', () => {
    const assembler = new JsonMessageAssembler();
    expect(assembler.push(`${encode({ op: 'a' })}{"op":"b"`)).toEqual([{ op: 'a' }]);
    expect(assembler.push('}')).toEqual([{ op: 'b' }]);
  });

  it('does not end an object at a brace inside a string', () => {
    expect(new JsonMessageAssembler().push('{"text":"}{"}')).toEqual([{ text: '}{' }]);
  });

  it('does not end a string at an escaped quote', () => {
    expect(new JsonMessageAssembler().push('{"text":"he said \\"}\\" twice"}')).toEqual([{ text: 'he said "}" twice' }]);
  });

  it('reads an escaped backslash before a closing quote as the end of the string', () => {
    expect(new JsonMessageAssembler().push('{"path":"C:\\\\"}{"op":"next"}')).toEqual([{ path: 'C:\\' }, { op: 'next' }]);
  });

  it('skips what lies between two objects, quotes included', () => {
    expect(new JsonMessageAssembler().push(`  junk ${encode({ op: 'a' })} ] "stray ${encode({ op: 'b' })}`)).toEqual([{ op: 'a' }, { op: 'b' }]);
  });

  it('skips what lies before the first object', () => {
    expect(new JsonMessageAssembler().push(`xx ${encode({ op: 'a' })}`)).toEqual([{ op: 'a' }]);
  });

  it('skips a stray closing brace before an object', () => {
    expect(new JsonMessageAssembler().push(`}}${encode({ op: 'a' })}`)).toEqual([{ op: 'a' }]);
  });

  it('drops an object that is not valid JSON and still returns the next one', () => {
    expect(new JsonMessageAssembler().push(`{not json}${encode({ op: 'ok' })}`)).toEqual([{ op: 'ok' }]);
  });

  it('starts afresh after an object, whatever state the previous one left', () => {
    const assembler = new JsonMessageAssembler();
    expect(assembler.push(encode({ text: 'a"b' }))).toEqual([{ text: 'a"b' }]);
    expect(assembler.push(encode({ op: 'after' }))).toEqual([{ op: 'after' }]);
  });

  it('gives up an object that never ends and reads the next one', () => {
    const assembler = new JsonMessageAssembler();
    expect(assembler.push(`{"text":"${'x'.repeat((1 << 20) + 10)}`)).toEqual([]);
    expect(assembler.push(encode({ op: 'after' }))).toEqual([{ op: 'after' }]);
  });

  it('keeps an object just under the limit', () => {
    const text = 'x'.repeat((1 << 20) - 64);
    expect(new JsonMessageAssembler().push(encode({ text }))).toEqual([{ text }]);
  });
});
