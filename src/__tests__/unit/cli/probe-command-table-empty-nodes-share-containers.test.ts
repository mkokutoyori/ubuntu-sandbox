/**
 * Probe: a node of the command tree allocates a container only when it
 * receives something to hold.
 *
 * Measured before the change on a Cisco router's table: 4259 specs make
 * 8381 nodes, of which 7116 have no keyword child, 4310 no argument place,
 * 3594 no command and 8212 no negation-only command, yet every node
 * allocated one Map and three arrays. A router cost 8.77 MB of heap and a
 * Cisco switch 4.97 MB (10 instances kept alive, forks pool, --expose-gc);
 * after the change 5.97 MB and 3.17 MB.
 *
 * Discrimination (git stash push -- src/cli): 2 of 5 cases fall on the base,
 * "two leaves hold the same empty containers" and "a shared empty list
 * refuses a write".
 * Pass either way:
 *  - "a leaf that later receives a child stops sharing" and "two tables do
 *    not see each other's declarations" are non-regression: they state what
 *    the sharing must never break;
 *  - "the parser still walks the tree" is the WITNESS that the table built
 *    in this file is a working table.
 */
import { describe, it, expect } from 'vitest';
import { CommandTable, type CommandSpec } from '@/cli/CommandTable';
import { newSession } from '@/cli/CliSession';
import { parseCommand } from '@/cli/CommandParser';

function spec(id: string, path: CommandSpec['path']): CommandSpec {
  return { id, path, description: id, modes: ['user'], minPrivilege: 1, run: () => id };
}

function leaf(table: CommandTable, ...keywords: string[]) {
  let node = table.rootNode();
  for (const keyword of keywords) node = node.children.get(keyword)!;
  return node;
}

describe('the containers of an empty tree node', () => {
  it('two leaves hold the same empty containers', () => {
    const table = new CommandTable();
    table.declare(spec('a', ['show', 'clock']));
    table.declare(spec('b', ['show', 'version']));
    const clock = leaf(table, 'show', 'clock');
    const version = leaf(table, 'show', 'version');
    expect(clock.children).toBe(version.children);
    expect(clock.argumentChildren).toBe(version.argumentChildren);
    expect(clock.undoOnlySpecs).toBe(version.undoOnlySpecs);
    expect(clock.children.size).toBe(0);
    expect(clock.specs).not.toBe(version.specs);
  });

  it('a shared empty list refuses a write', () => {
    const table = new CommandTable();
    table.declare(spec('a', ['show', 'clock']));
    const clock = leaf(table, 'show', 'clock');
    expect(() => clock.argumentChildren.push(clock)).toThrow(TypeError);
    expect(() => clock.undoOnlySpecs.push(spec('x', ['x']))).toThrow(TypeError);
  });

  it('a leaf that later receives a child stops sharing', () => {
    const table = new CommandTable();
    table.declare(spec('a', ['show', 'clock']));
    table.declare(spec('b', ['show', 'version']));
    table.declare(spec('c', ['show', 'clock', 'detail']));
    table.declare(spec('d', ['show', 'clock', { name: 'zone', type: 'WORD', description: 'zone' }]));
    const clock = leaf(table, 'show', 'clock');
    const version = leaf(table, 'show', 'version');
    expect([...clock.children.keys()]).toEqual(['detail']);
    expect(clock.argumentChildren).toHaveLength(1);
    expect(version.children.size).toBe(0);
    expect(version.argumentChildren).toHaveLength(0);
  });

  it('two tables do not see each other\'s declarations', () => {
    const first = new CommandTable();
    const second = new CommandTable();
    first.declare(spec('a', ['show', 'clock']));
    second.declare(spec('b', ['ping']));
    expect([...first.rootNode().children.keys()]).toEqual(['show']);
    expect([...second.rootNode().children.keys()]).toEqual(['ping']);
    expect(new CommandTable().rootNode().children.size).toBe(0);
  });

  it('the parser still walks the tree', () => {
    const table = new CommandTable();
    table.declare(spec('a', ['show', 'clock']));
    table.declare(spec('b', ['show', 'version']));
    const session = newSession('R1', {});
    const parsed = parseCommand(table, 'sh cl', session);
    expect(parsed.status).toBe('ok');
  });
});
