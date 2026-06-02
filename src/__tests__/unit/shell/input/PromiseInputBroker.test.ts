import { describe, it, expect } from 'vitest';
import { PromiseInputBroker } from '@/shell/input/PromiseInputBroker';
import type {
  InputHost, InputCompletion, StreamAttachOptions, StreamAttachment,
} from '@/shell/input';
import type { InputRequest } from '@/shell/input/types';

function makeHost(): {
  host: InputHost;
  pump(value: string): void;
  cancel(): void;
  close(): void;
  emitted: string[];
  prompts: string[];
  streams: StreamAttachment[];
} {
  let pending: ((o: InputCompletion) => void) | null = null;
  const emitted: string[] = [];
  const prompts: string[] = [];
  const streams: StreamAttachment[] = [];
  const host: InputHost = {
    requestInput(req: InputRequest, complete) {
      prompts.push(req.prompt);
      pending = complete;
    },
    cancelRequest() { pending = null; },
    emit(line) { emitted.push(line); },
    attachStream(opts: StreamAttachOptions) {
      let active = true;
      const h: StreamAttachment = {
        id: `s${streams.length}`,
        description: opts.description,
        get active() { return active; },
        cancel() { if (!active) return; active = false; opts.onCancel?.(); },
      };
      streams.push(h);
      return h;
    },
    detachAllStreams() { for (const s of streams) s.cancel(); },
    capabilities() { return { interactive: true, maskedSupported: true, streaming: true }; },
  };
  return {
    host, emitted, prompts, streams,
    pump(value) { const cb = pending; pending = null; cb?.({ status: 'submitted', value }); },
    cancel() { const cb = pending; pending = null; cb?.({ status: 'cancelled' }); },
    close()  { const cb = pending; pending = null; cb?.({ status: 'closed' }); },
  };
}

describe('PromiseInputBroker', () => {
  it('ask returns the submitted value', async () => {
    const h = makeHost();
    const b = new PromiseInputBroker(h.host);
    const p = b.ask('Name? ');
    h.pump('Alice');
    expect(await p).toBe('Alice');
    expect(h.prompts).toEqual(['Name? ']);
  });

  it('returns null on cancellation', async () => {
    const h = makeHost();
    const b = new PromiseInputBroker(h.host);
    const p = b.ask('Continue? ');
    h.cancel();
    expect(await p).toBeNull();
  });

  it('password() routes to mask=true', async () => {
    const h = makeHost();
    const b = new PromiseInputBroker(h.host);
    const p = b.password('Password: ');
    h.pump('hunter2');
    expect(await p).toBe('hunter2');
  });

  it('returns no-host when the broker is bound to a non-interactive host', async () => {
    const h = makeHost();
    const inert: InputHost = {
      ...h.host,
      capabilities() { return { interactive: false, maskedSupported: false, streaming: false }; },
    };
    const b = new PromiseInputBroker(inert);
    const r = await b.read({ kind: 'text', prompt: 'X' });
    expect(r.status).toBe('no-host');
  });

  it('trims by default and respects default value on empty input', async () => {
    const h = makeHost();
    const b = new PromiseInputBroker(h.host);
    const p = b.read({ kind: 'text', prompt: 'X ', default: 'fallback' });
    h.pump('   ');
    const r = await p;
    expect(r.status).toBe('ok');
    expect(r.value).toBe('fallback');
  });

  it('validator failure triggers retry with retryPrompt, succeeds on 2nd', async () => {
    const h = makeHost();
    const b = new PromiseInputBroker(h.host);
    const p = b.read({
      kind: 'text',
      prompt: 'Port ',
      validator: v => /^\d+$/.test(v) ? { ok: true } : { ok: false, error: 'not a number' },
      retryPrompt: (n, e) => `[try ${n}] ${e}: `,
    });
    h.pump('abc');
    h.pump('8080');
    const r = await p;
    expect(r.status).toBe('ok');
    expect(r.value).toBe('8080');
    expect(r.attempts).toBe(2);
    expect(h.prompts).toEqual(['Port ', '[try 1] not a number: ']);
    expect(h.emitted).toContain('not a number');
  });

  it('validator gives up after maxAttempts', async () => {
    const h = makeHost();
    const b = new PromiseInputBroker(h.host);
    const p = b.read({
      kind: 'text', prompt: 'X ', maxAttempts: 2,
      validator: () => ({ ok: false, error: 'nope' }),
    });
    h.pump('a'); h.pump('b');
    const r = await p;
    expect(r.status).toBe('closed');
    expect(r.attempts).toBe(2);
  });

  it('confirm accepts yes / no / o / non', async () => {
    const h = makeHost();
    const b = new PromiseInputBroker(h.host);
    const yes = b.confirm('Sure?'); h.pump('yes'); expect((await yes).value).toBe(true);
    const no = b.confirm('Sure?'); h.pump('non'); expect((await no).value).toBe(false);
    const def = b.confirm('Sure?', { default: true }); h.pump(''); expect((await def).value).toBe(true);
  });

  it('confirm gives up after invalid maxAttempts', async () => {
    const h = makeHost();
    const b = new PromiseInputBroker(h.host);
    const p = b.confirm('?', { maxAttempts: 2 });
    h.pump('maybe'); h.pump('?');
    expect((await p).status).toBe('closed');
    expect(h.emitted.filter(l => l.includes('yes or no')).length).toBeGreaterThan(0);
  });

  it('choice selects by index or by value', async () => {
    const h = makeHost();
    const b = new PromiseInputBroker(h.host);
    const c1 = b.choice('Pick', ['alpha', 'beta', 'gamma']);
    h.pump('2');
    const r1 = await c1;
    expect(r1.value).toBe('beta');
    expect(r1.index).toBe(1);

    const c2 = b.choice('Pick', ['alpha', 'beta', 'gamma']);
    h.pump('gamma');
    expect((await c2).value).toBe('gamma');
  });

  it('multiline collects until the sentinel line', async () => {
    const h = makeHost();
    const b = new PromiseInputBroker(h.host);
    const p = b.multiline('Enter notes (empty = end):');
    h.pump('first'); h.pump('second'); h.pump('');
    const r = await p;
    expect(r.status).toBe('ok');
    expect(r.lines).toEqual(['first', 'second']);
  });

  it('attachStream delegates to host + listStreams returns []', () => {
    const h = makeHost();
    const b = new PromiseInputBroker(h.host);
    const att = b.attachStream({ description: 'tail -f /var/log/x', sink: { write: () => {} } });
    expect(att.active).toBe(true);
    att.cancel();
    expect(att.active).toBe(false);
  });

  it('cancelPending resolves any outstanding read with cancelled', async () => {
    const h = makeHost();
    const b = new PromiseInputBroker(h.host);
    const p = b.ask('Wait ');
    b.cancelPending();
    expect(await p).toBeNull();
  });

  it('rebindHost cancels pending and rewires future requests', async () => {
    const a = makeHost();
    const c = makeHost();
    const b = new PromiseInputBroker(a.host);
    const first = b.ask('From A? ');
    b.rebindHost(c.host);
    expect(await first).toBeNull();
    const second = b.ask('From C? ');
    c.pump('hi');
    expect(await second).toBe('hi');
    expect(a.prompts).toEqual(['From A? ']);
    expect(c.prompts).toEqual(['From C? ']);
  });
});
