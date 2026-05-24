/**
 * Tests for the backend-driven terminal intent layer.
 *
 * These exercise the abstractions in isolation — no LinuxTerminalSession,
 * no React. The point is that flows are pure async functions over an
 * IntentChannel, the registry resolves aliases before dispatch, and
 * every input kind (text/password/confirm/select/secret/multiline) has a
 * round-trippable representation.
 */

import { describe, it, expect } from 'vitest';
import {
  InputPrompt, Validators, ShellActionRegistry, IntentRunner,
  PROMPT, OUTPUT, COMPLETE,
  type ShellAction, type ShellActionContext, type IntentChannel,
  type TerminalIntent, type InputResponse,
} from '@/terminal/intent';

function makeCtx(overrides: Partial<ShellActionContext> = {}): ShellActionContext {
  return {
    name: 'noop',
    args: [],
    typedLine: 'noop',
    resolvedLine: 'noop',
    device: {} as never,
    currentUser: 'alice',
    currentUid: 1000,
    metadata: new Map(),
    ...overrides,
  };
}

describe('InputPrompt — value object', () => {
  it('freezes options and exposes defaults sensibly', () => {
    const p = InputPrompt.password({ label: '[sudo] password for alice:' });
    expect(p.kind).toBe('password');
    expect(p.sensitive).toBe(true);
    expect(p.allowEmpty).toBe(false);
    expect(p.mask).toBe('hidden');
    expect(Object.isFrozen(p)).toBe(true);
  });

  it('refuses select without choices', () => {
    expect(() => InputPrompt.select({ label: 'Pick one' })).toThrowError(/choice/);
  });

  it('preserves custom validators', async () => {
    const p = InputPrompt.text({
      label: 'Username:',
      validator: Validators.pattern(/^[a-z]+$/, 'lowercase only'),
    });
    const bad = await p.validator!('Bad-Name');
    expect(bad.valid).toBe(false);
    expect(bad.errorMessage).toBe('lowercase only');
  });
});

describe('Validators — composable predicates', () => {
  it('all() short-circuits on first failure', async () => {
    const v = Validators.all(
      Validators.nonEmpty('empty'),
      Validators.minLength(3, 'too short'),
    );
    expect(await v('')).toEqual({ valid: false, errorMessage: 'empty' });
    expect(await v('hi')).toEqual({ valid: false, errorMessage: 'too short' });
    expect(await v('hello')).toEqual({ valid: true });
  });

  it('matches() compares against a late-bound source', async () => {
    let saved = 'topSecret';
    const v = Validators.matches(() => saved);
    expect(await v('topSecret')).toEqual({ valid: true });
    saved = 'changed';
    expect(await v('topSecret')).toEqual({ valid: false, errorMessage: 'Values do not match' });
  });
});

describe('ShellActionRegistry — alias-aware dispatch', () => {
  const dummy: ShellAction = {
    name: 'sudo',
    flow: async () => undefined,
  };

  it('matches exact head', () => {
    const reg = new ShellActionRegistry();
    reg.register(dummy);
    const r = reg.resolve('sudo whoami');
    expect(r?.action).toBe(dummy);
    expect(r?.args).toEqual(['whoami']);
  });

  it('routes aliased head to the canonical action', () => {
    const reg = new ShellActionRegistry({
      expand: (line) => line.replace(/^please\b/, 'sudo'),
    });
    reg.register(dummy);
    const r = reg.resolve('please whoami');
    expect(r?.action).toBe(dummy);
    expect(r?.resolvedLine).toBe('sudo whoami');
  });

  it('respects per-action `match` predicate when name lookup misses', () => {
    const reg = new ShellActionRegistry();
    const ssh: ShellAction = {
      name: 'ssh',
      match: head => head === 'ssh' || head === 'sshpass',
      flow: async () => undefined,
    };
    reg.register(ssh);
    expect(reg.resolve('sshpass -p x user@h')?.action).toBe(ssh);
  });

  it('returns null when nothing matches', () => {
    const reg = new ShellActionRegistry();
    expect(reg.resolve('ls -la')).toBeNull();
  });

  it('honours single/double quotes in tokenisation', () => {
    const reg = new ShellActionRegistry();
    reg.register(dummy);
    const r = reg.resolve(`sudo "rm -rf /tmp/x y"`);
    expect(r?.args).toEqual(['rm -rf /tmp/x y']);
  });
});

describe('IntentRunner — drives a flow against a recording handler', () => {
  it('plays output → prompt → output → complete in order', async () => {
    const events: TerminalIntent[] = [];
    const reply: InputResponse = { value: 'admin' };
    const action: ShellAction = {
      name: 'sudo',
      flow: async (_ctx, channel) => {
        await channel.emit(OUTPUT('Starting sudo…'));
        const r = await channel.ask(PROMPT(InputPrompt.password({ label: '[sudo] password:' })));
        await channel.emit(OUTPUT(`got password of length ${r.value.length}`));
      },
    };

    const runner = new IntentRunner(action.flow, makeCtx({ name: 'sudo' }), {
      onIntent: (i) => {
        events.push(i);
        if (i.kind === 'prompt') {
          setTimeout(() => runner.respond(reply), 0);
        }
      },
    });
    await runner.start();

    expect(events.map(e => e.kind)).toEqual(['output', 'prompt', 'output', 'complete']);
    const lastOutput = events[2];
    if (lastOutput.kind !== 'output') throw new Error('expected output');
    expect(lastOutput.lines[0]).toBe('got password of length 5');
    expect(runner.isFinished).toBe(true);
  });

  it('lets a flow ask for confirm + select + secret in sequence', async () => {
    const events: TerminalIntent[] = [];
    const responses: InputResponse[] = [
      { value: 'yes' },
      { value: 'green' },
      { value: '123-456' },
    ];
    let idx = 0;
    const action: ShellAction = {
      name: 'wizard',
      flow: async (_ctx, ch) => {
        await ch.ask(PROMPT(InputPrompt.confirm({ label: 'Continue?', defaultAnswer: 'no' })));
        await ch.ask(PROMPT(InputPrompt.select({
          label: 'Colour',
          choices: [{ key: 'red', label: 'Red' }, { key: 'green', label: 'Green' }],
        })));
        await ch.ask(PROMPT(InputPrompt.secret({ label: 'Recovery code' })));
      },
    };
    const runner = new IntentRunner(action.flow, makeCtx(), {
      onIntent: (i) => {
        events.push(i);
        if (i.kind === 'prompt') setTimeout(() => runner.respond(responses[idx++]), 0);
      },
    });
    await runner.start();
    expect(events.filter(e => e.kind === 'prompt')).toHaveLength(3);
    expect((events.filter(e => e.kind === 'prompt')[2] as Extract<TerminalIntent, { kind: 'prompt' }>).prompt.kind).toBe('secret');
  });
});

describe('COMPLETE / OUTPUT helpers', () => {
  it('OUTPUT() accepts a single string', () => {
    const i = OUTPUT('hi');
    expect(i.lines).toEqual(['hi']);
  });
  it('COMPLETE() defaults exit code 0', () => {
    expect(COMPLETE().exitCode).toBe(0);
    expect(COMPLETE(2).exitCode).toBe(2);
  });
});
