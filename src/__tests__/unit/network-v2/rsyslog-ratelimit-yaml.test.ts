/**
 * Probe - the YAML of a ratelimit() policy file is read by libyaml in rsyslog (runtime/ratelimit.c: yaml_parser_parse until
 * YAML_STREAM_END_EVENT, scalars as C strings, aliases ignored, a parse failure logged as
 * "ratelimit: yaml parser error in policy file <path>: <problem>").  src/network/yaml is a port of libyaml's reader, scanner and
 * parser, compared with the real library by yaml-libyaml-oracle.test.ts; here the consumer is exercised with what a line-based reader
 * of the common subset could not read: anchors and tags on a value, block scalars (| and >), multi-line plain and quoted scalars,
 * double-quoted escapes, a flow mapping that spans lines, explicit keys, document markers and %YAML directives - and with the
 * errors libyaml words itself (tab indentation, an unterminated flow collection, an unknown directive, a control character).
 * Measured before the port (git stash push -- src/network): 13 of the 20 cases fall.  The 7 that pass either way are the WITNESS
 * (a plain block mapping), non-regressions of what the line-based reader already read (double-quoted escapes, a doubled single
 * quote, a comment after a value) and three refusals it already worded as libyaml does (tab indentation, an unterminated flow
 * mapping, a second value indicator on one line).
 */
import { describe, expect, it } from 'vitest';
import { parsePolicyFile, type PolicyFile } from '@/network/rsyslog/engine/RateLimitPolicy';

interface Outcome {
  readonly policy: PolicyFile | null;
  readonly errors: string[];
}

function read(text: string): Outcome {
  const errors: string[] = [];
  const files = { exists: () => true, read: () => text };
  const policy = parsePolicyFile(files, '/etc/rl.yaml', { error: (message) => errors.push(message) });
  return { policy, errors };
}

const ok = (text: string): PolicyFile => {
  const outcome = read(text);
  expect(outcome.errors).toEqual([]);
  return outcome.policy as PolicyFile;
};
const problem = (text: string): string => {
  const outcome = read(text);
  expect(outcome.policy).toBeNull();
  return outcome.errors.join('\n');
};
const PREFIX = 'ratelimit: yaml parser error in policy file /etc/rl.yaml: ';

describe('YAML read by the libyaml port', () => {
  it('witness: a plain block mapping', () => {
    const policy = ok('interval: 5\nburst: 10\n');
    expect([policy.interval, policy.burst]).toEqual([5, 10]);
  });

  it('reads an anchor on a value', () => {
    expect(ok('interval: &i 5\nburst: 10\n').interval).toBe(5);
  });

  it('reads a tag on a value', () => {
    expect(ok('interval: 5\nburst: !!int 10\n').burst).toBe(10);
  });

  it('reads an anchor and a tag together, in either order', () => {
    const policy = ok('interval: &a !!int 5\nburst: !!int &b 10\n');
    expect([policy.interval, policy.burst]).toEqual([5, 10]);
  });

  it('reads a folded block scalar with strip chomping', () => {
    expect(ok('interval: >-\n  5\nburst: 10\n').interval).toBe(5);
  });

  it('keeps the newline of a literal block scalar, which is not a number', () => {
    expect(problem('interval: |\n  5\nburst: 10\n')).toContain("invalid interval value '5\n'");
  });

  it('folds a multi-line double-quoted scalar into one line', () => {
    expect(ok('scope: "in\\\n  put"\ninterval: 5\nburst: 10\n').scope).toBe('input');
  });

  it('folds a multi-line plain scalar with a single space', () => {
    expect(problem('scope: in\n  put\n')).toContain("invalid scope value 'in put'");
  });

  it('decodes double-quoted escapes', () => {
    expect(ok('interval: "\\x35"\nburst: "\\u0031\\u0030"\n').burst).toBe(10);
  });

  it('reads single-quoted scalars with a doubled quote', () => {
    expect(problem("scope: 'it''s'\n")).toContain("invalid scope value 'it's'");
  });

  it('reads a flow mapping that spans lines', () => {
    const policy = ok('perSource: {\n  keyTemplate: "PerSourceIP",\n  default: {max: 2,\n    window: 10s}\n}\ninterval: 5\nburst: 10\n');
    expect(policy.perSource?.defaultMax).toBe(2);
  });

  it('reads explicit keys', () => {
    const policy = ok('? interval\n: 5\n? burst\n: 10\n');
    expect([policy.interval, policy.burst]).toEqual([5, 10]);
  });

  it('reads document markers and a %YAML directive', () => {
    const policy = ok('%YAML 1.1\n---\ninterval: 5\nburst: 10\n...\n');
    expect([policy.interval, policy.burst]).toEqual([5, 10]);
  });

  it('truncates a scalar at an embedded NUL, as the C string of the source does', () => {
    expect(ok('interval: "5\\0abc"\nburst: 10\n').interval).toBe(5);
  });

  it('ignores a comment after a value', () => {
    expect(ok('interval: 5 # seconds\nburst: 10\n').interval).toBe(5);
  });

  it('refuses a tab used as indentation with the libyaml wording', () => {
    expect(problem('perSource:\n\tdefault: 1\n')).toBe(`${PREFIX}found character that cannot start any token`);
  });

  it('refuses an unterminated flow collection', () => {
    expect(problem('perSource: {default: {max: 2\n')).toBe(`${PREFIX}did not find expected ',' or '}'`);
  });

  it('refuses an unknown directive', () => {
    expect(problem('%FOO bar\n---\ninterval: 5\n')).toBe(`${PREFIX}found unknown directive name`);
  });

  it('refuses a control character with the reader wording', () => {
    expect(problem('interval: 5\u0001\n')).toBe(`${PREFIX}control characters are not allowed`);
  });

  it('refuses a second value indicator on one line with the scanner wording', () => {
    expect(problem('foo: bar: baz\n')).toBe(`${PREFIX}mapping values are not allowed in this context`);
  });
});
