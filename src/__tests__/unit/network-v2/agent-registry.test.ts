import { describe, it, expect } from 'vitest';
import { AgentRegistry, type ManagedAgent } from '@/network/devices/AgentRegistry';

function probe(log: string[], name: string): ManagedAgent {
  return {
    start: () => log.push(`${name}:start`),
    stop: () => log.push(`${name}:stop`),
  };
}

describe('AgentRegistry', () => {
  it('register() records without starting, startAll() starts in order', () => {
    const log: string[] = [];
    const reg = new AgentRegistry();
    reg.register(probe(log, 'a'));
    reg.register(probe(log, 'b'));
    expect(log).toEqual([]);
    reg.startAll();
    expect(log).toEqual(['a:start', 'b:start']);
  });

  it('register() returns the agent so fields can be assigned inline', () => {
    const reg = new AgentRegistry();
    const agent = probe([], 'x');
    expect(reg.register(agent)).toBe(agent);
    expect(reg.size()).toBe(1);
  });

  it('registerAll() preserves argument order', () => {
    const log: string[] = [];
    const reg = new AgentRegistry();
    reg.registerAll(probe(log, 'a'), probe(log, 'b'), probe(log, 'c'));
    reg.startAll();
    expect(log).toEqual(['a:start', 'b:start', 'c:start']);
  });

  it('restartAll() stops then starts each agent, like a bus re-injection', () => {
    const log: string[] = [];
    const reg = new AgentRegistry();
    reg.registerAll(probe(log, 'a'), probe(log, 'b'));
    reg.restartAll();
    expect(log).toEqual(['a:stop', 'a:start', 'b:stop', 'b:start']);
  });

  it('stopAll() stops everything; an empty registry is a no-op', () => {
    const log: string[] = [];
    const reg = new AgentRegistry();
    reg.stopAll();
    reg.registerAll(probe(log, 'a'), probe(log, 'b'));
    reg.stopAll();
    expect(log).toEqual(['a:stop', 'b:stop']);
  });
});
