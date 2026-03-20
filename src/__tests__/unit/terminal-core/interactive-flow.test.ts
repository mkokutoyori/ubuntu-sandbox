/**
 * Tests for InteractiveFlowEngine.
 *
 * Covers:
 *   - Step-by-step progression through flows
 *   - Password validation with retries
 *   - Text input collection
 *   - Confirmation handling
 *   - Branch/conditional steps
 *   - Execute steps (with error handling)
 *   - Flow completion and abort scenarios
 *   - Context value accumulation
 */

import { describe, it, expect, vi } from 'vitest';
import { InteractiveFlowEngine } from '@/terminal/core/InteractiveFlow';
import { AnsiOutputFormatter } from '@/terminal/core/OutputFormatter';
import type { InteractiveStep, FlowContext } from '@/terminal/core/types';

// ─── Test helpers ───────────────────────────────────────────────────

function createMockContext(overrides?: Partial<FlowContext>): FlowContext {
  return {
    values: new Map(),
    device: {
      checkPassword: vi.fn().mockReturnValue(true),
      setUserPassword: vi.fn(),
      ...((overrides?.device as any) ?? {}),
    } as any,
    currentUser: 'testuser',
    currentUid: 1000,
    metadata: new Map(),
    ...overrides,
  };
}

function createEngine(
  steps: InteractiveStep[],
  ctx?: FlowContext,
  prompt?: string,
): InteractiveFlowEngine {
  return new InteractiveFlowEngine(
    steps,
    ctx ?? createMockContext(),
    new AnsiOutputFormatter(),
    prompt ?? 'testuser@host:~$ ',
  );
}

// ─── Basic flow progression ──────────────────────────────────────────

describe('InteractiveFlowEngine', () => {
  describe('basic flow progression', () => {
    it('completes immediately with empty steps', async () => {
      const engine = createEngine([]);
      const response = await engine.advance();
      expect(engine.isComplete).toBe(true);
      expect(response.inputDirective.type).toBe('command');
    });

    it('processes output steps automatically', async () => {
      const engine = createEngine([
        { type: 'output', outputLines: ['Hello', 'World'] },
        { type: 'output', outputLines: ['Done'] },
      ]);

      const response = await engine.advance();
      expect(engine.isComplete).toBe(true);
      expect(response.lines.length).toBeGreaterThanOrEqual(3);
      expect(response.inputDirective.type).toBe('command');
    });

    it('pauses on password step and returns password directive', async () => {
      const engine = createEngine([
        { type: 'password', prompt: 'Enter password:', mask: 'hidden', storeAs: 'pwd' },
      ]);

      const response = await engine.advance();
      expect(engine.isComplete).toBe(false);
      expect(response.inputDirective.type).toBe('password');
      if (response.inputDirective.type === 'password') {
        expect(response.inputDirective.prompt).toBe('Enter password:');
        expect(response.inputDirective.mask).toBe('hidden');
      }
    });

    it('pauses on text step and returns text-prompt directive', async () => {
      const engine = createEngine([
        { type: 'text', prompt: 'Full Name []:', allowEmpty: true, storeAs: 'name' },
      ]);

      const response = await engine.advance();
      expect(engine.isComplete).toBe(false);
      expect(response.inputDirective.type).toBe('text-prompt');
      if (response.inputDirective.type === 'text-prompt') {
        expect(response.inputDirective.prompt).toBe('Full Name []:');
        expect(response.inputDirective.allowEmpty).toBe(true);
      }
    });

    it('pauses on confirmation step', async () => {
      const engine = createEngine([
        { type: 'confirmation', prompt: 'Continue? [Y/n]', defaultAnswer: 'yes', storeAs: 'answer' },
      ]);

      const response = await engine.advance();
      expect(response.inputDirective.type).toBe('confirmation');
    });
  });

  // ─── Input submission ───────────────────────────────────────────────

  describe('input submission', () => {
    it('stores value and advances after password submission', async () => {
      const ctx = createMockContext();
      const engine = createEngine([
        { type: 'password', prompt: 'Password:', storeAs: 'pwd' },
        { type: 'output', outputLines: ['Authenticated!'] },
      ], ctx);

      // First advance: pauses on password
      await engine.advance();
      expect(engine.isComplete).toBe(false);

      // Submit password
      const response = await engine.advance('secret123');
      expect(engine.isComplete).toBe(true);
      expect(ctx.values.get('pwd')).toBe('secret123');
      expect(response.inputDirective.type).toBe('command');
    });

    it('stores text input and continues', async () => {
      const ctx = createMockContext();
      const engine = createEngine([
        { type: 'text', prompt: 'Name:', storeAs: 'name', allowEmpty: true },
        { type: 'text', prompt: 'Email:', storeAs: 'email', allowEmpty: true },
      ], ctx);

      await engine.advance(); // pause on name
      await engine.advance('John Doe'); // submit name, pause on email
      expect(ctx.values.get('name')).toBe('John Doe');

      await engine.advance('john@example.com');
      expect(ctx.values.get('email')).toBe('john@example.com');
      expect(engine.isComplete).toBe(true);
    });

    it('handles empty text input when allowEmpty is true', async () => {
      const ctx = createMockContext();
      const engine = createEngine([
        { type: 'text', prompt: 'Optional:', storeAs: 'field', allowEmpty: true },
      ], ctx);

      await engine.advance();
      const response = await engine.advance('');
      expect(ctx.values.get('field')).toBe('');
      expect(engine.isComplete).toBe(true);
    });
  });

  // ─── Validation ────────────────────────────────────────────────────

  describe('validation', () => {
    it('retries on validation failure', async () => {
      let callCount = 0;
      const engine = createEngine([
        {
          type: 'password',
          prompt: 'Password:',
          storeAs: 'pwd',
          validation: (val) => {
            callCount++;
            return { valid: val === 'correct', errorMessage: 'Wrong password', maxRetries: 3 };
          },
        },
      ]);

      await engine.advance(); // pause on password

      // Wrong password — should retry
      const retry1 = await engine.advance('wrong');
      expect(engine.isComplete).toBe(false);
      expect(retry1.inputDirective.type).toBe('password');
      expect(retry1.lines.some(l => l.segments.some(s => s.text.includes('Wrong')))).toBe(true);

      // Correct password
      const success = await engine.advance('correct');
      expect(engine.isComplete).toBe(true);
      expect(callCount).toBe(2);
    });

    it('aborts after max retries exceeded', async () => {
      const engine = createEngine([
        {
          type: 'password',
          prompt: 'Password:',
          storeAs: 'pwd',
          validation: () => ({ valid: false, errorMessage: 'Nope', maxRetries: 1 }),
        },
        { type: 'output', outputLines: ['Should not reach here'] },
      ]);

      await engine.advance();      // pause on password
      await engine.advance('bad1'); // retry 1
      const aborted = await engine.advance('bad2'); // retry 2 → exceed maxRetries

      // Should abort — return command directive, skip remaining steps
      expect(aborted.inputDirective.type).toBe('command');
      expect(aborted.bell).toBe(true);
    });
  });

  // ─── Execute steps ────────────────────────────────────────────────

  describe('execute steps', () => {
    it('calls action function with context', async () => {
      const action = vi.fn();
      const ctx = createMockContext();
      const engine = createEngine([
        { type: 'execute', action },
      ], ctx);

      await engine.advance();
      expect(action).toHaveBeenCalledWith(ctx);
      expect(engine.isComplete).toBe(true);
    });

    it('handles action errors gracefully', async () => {
      const engine = createEngine([
        {
          type: 'execute',
          action: async () => { throw new Error('Device offline'); },
        },
        { type: 'output', outputLines: ['Should not appear'] },
      ]);

      const response = await engine.advance();
      // Should abort flow on error
      expect(response.inputDirective.type).toBe('command');
      expect(response.lines.some(l => l.segments.some(s => s.text.includes('Device offline')))).toBe(true);
    });
  });

  // ─── Branch steps ─────────────────────────────────────────────────

  describe('branch steps', () => {
    it('jumps to the correct step index', async () => {
      const ctx = createMockContext();
      ctx.values.set('choice', 'skip');

      const engine = createEngine([
        {
          type: 'branch',
          predicate: (c) => c.values.get('choice') === 'skip' ? 2 : 1,
        },
        { type: 'output', outputLines: ['Step 1 (skipped)'] },
        { type: 'output', outputLines: ['Step 2 (reached)'] },
      ], ctx);

      const response = await engine.advance();
      expect(engine.isComplete).toBe(true);
      const texts = response.lines.map(l => l.segments.map(s => s.text).join(''));
      expect(texts.some(t => t.includes('Step 2'))).toBe(true);
      expect(texts.some(t => t.includes('Step 1'))).toBe(false);
    });

    it('jumps beyond steps to end flow', async () => {
      const engine = createEngine([
        { type: 'branch', predicate: () => 999 },
        { type: 'output', outputLines: ['Never reached'] },
      ]);

      const response = await engine.advance();
      expect(engine.isComplete).toBe(true);
      expect(response.lines).toHaveLength(0);
    });
  });

  // ─── Complex multi-step flow ──────────────────────────────────────

  describe('complex multi-step flow', () => {
    it('processes a sudo passwd flow end-to-end', async () => {
      const mockDevice = {
        checkPassword: vi.fn().mockReturnValue(true),
        setUserPassword: vi.fn(),
      };
      const ctx: FlowContext = {
        values: new Map(),
        device: mockDevice as any,
        currentUser: 'admin',
        currentUid: 1000,
        metadata: new Map(),
      };

      const steps: InteractiveStep[] = [
        {
          type: 'password',
          prompt: '[sudo] password for admin:',
          storeAs: 'sudo_pwd',
          validation: (pwd, c) => ({
            valid: c.device.checkPassword(c.currentUser, pwd),
            errorMessage: 'Sorry, try again.',
            maxRetries: 2,
          }),
        },
        { type: 'password', prompt: 'New password:', storeAs: 'new_password' },
        {
          type: 'password',
          prompt: 'Retype new password:',
          storeAs: 'confirm_password',
          validation: (pwd, c) => ({
            valid: pwd === c.values.get('new_password'),
            errorMessage: 'Passwords do not match.',
            maxRetries: 0,
          }),
        },
        {
          type: 'execute',
          action: async (c) => {
            c.device.setUserPassword('targetuser', c.values.get('new_password')!);
          },
        },
        { type: 'output', outputLines: ['passwd: password updated successfully'] },
      ];

      const engine = createEngine(steps, ctx);

      // Step 1: sudo password prompt
      let resp = await engine.advance();
      expect(resp.inputDirective.type).toBe('password');

      // Submit correct sudo password
      resp = await engine.advance('sudopass');
      expect(resp.inputDirective.type).toBe('password');

      // Submit new password
      resp = await engine.advance('newpass123');
      expect(resp.inputDirective.type).toBe('password');

      // Submit matching retype password
      resp = await engine.advance('newpass123');
      expect(engine.isComplete).toBe(true);
      expect(mockDevice.setUserPassword).toHaveBeenCalledWith('targetuser', 'newpass123');
      expect(resp.inputDirective.type).toBe('command');
    });

    it('fails sudo passwd when passwords dont match', async () => {
      const ctx = createMockContext();

      const steps: InteractiveStep[] = [
        { type: 'password', prompt: 'New password:', storeAs: 'new_password' },
        {
          type: 'password',
          prompt: 'Retype new password:',
          storeAs: 'confirm_password',
          validation: (pwd, c) => ({
            valid: pwd === c.values.get('new_password'),
            errorMessage: 'Passwords do not match.',
            maxRetries: 0,
          }),
        },
      ];

      const engine = createEngine(steps, ctx);

      await engine.advance();              // new password prompt
      await engine.advance('pass1');       // submit new password
      const resp = await engine.advance('pass2'); // mismatch → abort

      expect(resp.inputDirective.type).toBe('command');
      expect(resp.bell).toBe(true);
    });
  });

  // ─── Context value accumulation ───────────────────────────────────

  describe('context accumulation', () => {
    it('accumulates values across multiple input steps', async () => {
      const ctx = createMockContext();
      const engine = createEngine([
        { type: 'text', prompt: 'Name:', storeAs: 'name', allowEmpty: true },
        { type: 'text', prompt: 'Room:', storeAs: 'room', allowEmpty: true },
        { type: 'text', prompt: 'Phone:', storeAs: 'phone', allowEmpty: true },
      ], ctx);

      await engine.advance();
      await engine.advance('John');
      await engine.advance('101');
      await engine.advance('555-0123');

      expect(ctx.values.get('name')).toBe('John');
      expect(ctx.values.get('room')).toBe('101');
      expect(ctx.values.get('phone')).toBe('555-0123');
      expect(engine.isComplete).toBe(true);
    });

    it('getContext returns accumulated values', async () => {
      const ctx = createMockContext();
      const engine = createEngine([
        { type: 'text', prompt: 'Q:', storeAs: 'answer', allowEmpty: true },
      ], ctx);

      await engine.advance();
      await engine.advance('42');

      const finalCtx = engine.getContext();
      expect(finalCtx.values.get('answer')).toBe('42');
    });
  });

  // ─── scrollToBottom / clearScreen / bell ───────────────────────────

  describe('response properties', () => {
    it('sets scrollToBottom on all responses', async () => {
      const engine = createEngine([
        { type: 'output', outputLines: ['test'] },
      ]);

      const response = await engine.advance();
      expect(response.scrollToBottom).toBe(true);
    });

    it('does not set clearScreen', async () => {
      const engine = createEngine([
        { type: 'output', outputLines: ['test'] },
      ]);

      const response = await engine.advance();
      expect(response.clearScreen).toBe(false);
    });

    it('sets bell on abort', async () => {
      const engine = createEngine([
        {
          type: 'password',
          prompt: 'Pwd:',
          validation: () => ({ valid: false, errorMessage: 'Nope', maxRetries: 0 }),
        },
      ]);

      await engine.advance();
      const response = await engine.advance('bad');
      expect(response.bell).toBe(true);
    });
  });
});
