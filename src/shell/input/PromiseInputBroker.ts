import type {
  InputRequest, InputResult, ConfirmResult, MultilineResult, ChoiceResult,
  StreamAttachment, StreamAttachOptions, InputCapabilities,
} from './types';
import type { InputBroker } from './InputBroker';
import type { InputHost, InputCompletion } from './InputHost';

const DEFAULT_YES = ['y', 'yes', 'o', 'oui'];
const DEFAULT_NO  = ['n', 'no', 'non'];

export class PromiseInputBroker implements InputBroker {
  private pendingCancel: (() => void) | null = null;

  constructor(private host: InputHost) {}

  rebindHost(host: InputHost): void {
    this.cancelPending();
    this.host = host;
  }

  capabilities(): InputCapabilities {
    return this.host.capabilities();
  }

  cancelPending(): void {
    const cancel = this.pendingCancel;
    this.pendingCancel = null;
    cancel?.();
  }

  read(req: InputRequest): Promise<InputResult> {
    if (!this.host.capabilities().interactive) {
      return Promise.resolve({ status: 'no-host', attempts: 0 });
    }
    if (req.kind === 'confirm') {
      return this.runConfirm(req).then(r => ({
        status: r.status,
        value: r.value === undefined ? undefined : (r.value ? 'yes' : 'no'),
        raw: r.value === undefined ? undefined : (r.value ? 'yes' : 'no'),
        attempts: r.attempts,
      }));
    }
    if (req.kind === 'choice') {
      return this.runChoice(req).then(r => ({
        status: r.status, value: r.value, raw: r.value, attempts: r.attempts,
      }));
    }
    if (req.kind === 'multiline') {
      return this.runMultiline(req).then(r => ({
        status: r.status,
        value: r.lines?.join('\n'),
        raw: r.lines?.join('\n'),
        attempts: r.attempts,
      }));
    }
    return this.runSingle(req);
  }

  ask(prompt: string, opts: Partial<InputRequest> = {}): Promise<string | null> {
    return this.read({ ...opts, kind: 'text', prompt })
      .then(r => r.status === 'ok' ? (r.value ?? '') : null);
  }

  password(prompt: string, opts: Partial<InputRequest> = {}): Promise<string | null> {
    return this.read({ ...opts, kind: 'password', prompt, mask: true, echo: false })
      .then(r => r.status === 'ok' ? (r.value ?? '') : null);
  }

  confirm(prompt: string, opts: {
    default?: boolean; yesWords?: readonly string[]; noWords?: readonly string[]; maxAttempts?: number;
  } = {}): Promise<ConfirmResult> {
    const hint = opts.default === true ? ' [Y/n] ' : opts.default === false ? ' [y/N] ' : ' [y/n] ';
    return this.runConfirm({
      kind: 'confirm',
      prompt: prompt.endsWith(' ') ? prompt + hint.trimStart() : prompt + hint,
      default: opts.default === undefined ? undefined : opts.default ? 'yes' : 'no',
      choices: (opts.yesWords ?? DEFAULT_YES).concat(opts.noWords ?? DEFAULT_NO),
      maxAttempts: opts.maxAttempts ?? 3,
    });
  }

  choice(prompt: string, choices: readonly string[], opts: {
    labels?: readonly string[]; default?: string; maxAttempts?: number;
  } = {}): Promise<ChoiceResult> {
    return this.runChoice({
      kind: 'choice',
      prompt,
      choices,
      choiceLabels: opts.labels,
      default: opts.default,
      maxAttempts: opts.maxAttempts ?? 3,
    });
  }

  multiline(prompt: string, opts: { until?: string; max?: number } = {}): Promise<MultilineResult> {
    return this.runMultiline({
      kind: 'multiline',
      prompt,
      until: opts.until ?? '',
      maxAttempts: opts.max,
    });
  }

  attachStream(opts: StreamAttachOptions): StreamAttachment {
    return this.host.attachStream(opts);
  }

  detachAllStreams(): void { this.host.detachAllStreams(); }

  listStreams(): readonly StreamAttachment[] { return []; }

  private runSingle(req: InputRequest): Promise<InputResult> {
    return new Promise(resolve => {
      let attempts = 0;
      const trigger = (effectivePrompt: string) => {
        this.host.requestInput({ ...req, prompt: effectivePrompt }, (outcome) => this.handleOutcome(req, outcome, ++attempts, resolve, retry));
      };
      const retry = (effectivePrompt: string) => trigger(effectivePrompt);
      this.pendingCancel = () => {
        this.host.cancelRequest();
        resolve({ status: 'cancelled', attempts });
      };
      trigger(req.prompt);
    });
  }

  private handleOutcome(
    req: InputRequest,
    outcome: InputCompletion,
    attempt: number,
    resolve: (r: InputResult) => void,
    retry: (prompt: string) => void,
  ): void {
    if (outcome.status !== 'submitted') {
      this.pendingCancel = null;
      resolve({ status: outcome.status, attempts: attempt });
      return;
    }
    const raw = outcome.value;
    const trimmed = req.trim === false ? raw : raw.replace(/\r$/, '');
    const usable = req.trim === false ? raw : trimmed.trim();
    if (usable === '' && req.default !== undefined) {
      this.pendingCancel = null;
      resolve({ status: 'ok', value: req.default, raw, attempts: attempt });
      return;
    }
    if (req.validator) {
      const v = req.validator(usable);
      if (!v.ok) {
        if (req.maxAttempts && attempt >= req.maxAttempts) {
          this.pendingCancel = null;
          resolve({ status: 'closed', raw, attempts: attempt });
          return;
        }
        const nextPrompt = req.retryPrompt ? req.retryPrompt(attempt, v.error) : `${v.error}\n${req.prompt}`;
        this.host.emit(v.error);
        retry(nextPrompt);
        return;
      }
      const value = v.value ?? usable;
      this.pendingCancel = null;
      resolve({ status: 'ok', value, raw, attempts: attempt });
      return;
    }
    this.pendingCancel = null;
    resolve({ status: 'ok', value: usable, raw, attempts: attempt });
  }

  private runConfirm(req: InputRequest): Promise<ConfirmResult> {
    return new Promise(resolve => {
      let attempts = 0;
      const yesWords = (req.choices ?? DEFAULT_YES.concat(DEFAULT_NO))
        .filter(w => DEFAULT_YES.includes(w.toLowerCase()))
        .map(w => w.toLowerCase());
      const noWords = (req.choices ?? DEFAULT_YES.concat(DEFAULT_NO))
        .filter(w => DEFAULT_NO.includes(w.toLowerCase()))
        .map(w => w.toLowerCase());
      const fallbackYes = yesWords.length ? yesWords : DEFAULT_YES;
      const fallbackNo  = noWords.length  ? noWords  : DEFAULT_NO;
      const maxAttempts = req.maxAttempts ?? 3;

      const ask = (prompt: string) => {
        this.host.requestInput({ ...req, prompt, kind: 'text', mask: false, echo: true }, (outcome) => {
          attempts++;
          if (outcome.status !== 'submitted') {
            this.pendingCancel = null;
            resolve({ status: outcome.status, attempts });
            return;
          }
          const v = outcome.value.trim().toLowerCase();
          if (v === '' && req.default !== undefined) {
            this.pendingCancel = null;
            resolve({ status: 'ok', value: req.default === 'yes' || req.default === 'y' || req.default === 'true', attempts });
            return;
          }
          if (fallbackYes.includes(v)) {
            this.pendingCancel = null;
            resolve({ status: 'ok', value: true, attempts });
            return;
          }
          if (fallbackNo.includes(v)) {
            this.pendingCancel = null;
            resolve({ status: 'ok', value: false, attempts });
            return;
          }
          if (attempts >= maxAttempts) {
            this.pendingCancel = null;
            resolve({ status: 'closed', attempts });
            return;
          }
          this.host.emit(`Please answer yes or no.`);
          ask(req.prompt);
        });
      };
      this.pendingCancel = () => {
        this.host.cancelRequest();
        resolve({ status: 'cancelled', attempts });
      };
      ask(req.prompt);
    });
  }

  private runChoice(req: InputRequest): Promise<ChoiceResult> {
    return new Promise(resolve => {
      let attempts = 0;
      const choices = (req.choices ?? []).map(c => String(c));
      if (choices.length === 0) {
        resolve({ status: 'closed', attempts: 0 });
        return;
      }
      const labels = req.choiceLabels && req.choiceLabels.length === choices.length
        ? req.choiceLabels.map(l => String(l)) : choices;

      const renderMenu = () => labels.map((l, i) => `  ${i + 1}) ${l}`).join('\n');

      const ask = (prompt: string) => {
        const fullPrompt = `${prompt}\n${renderMenu()}\nSelect [1-${choices.length}]: `;
        this.host.requestInput({ ...req, prompt: fullPrompt, kind: 'text', mask: false, echo: true }, (outcome) => {
          attempts++;
          if (outcome.status !== 'submitted') {
            this.pendingCancel = null;
            resolve({ status: outcome.status, attempts });
            return;
          }
          const v = outcome.value.trim();
          if (v === '' && req.default !== undefined) {
            const idx = choices.findIndex(c => c.toLowerCase() === String(req.default).toLowerCase());
            if (idx >= 0) {
              this.pendingCancel = null;
              resolve({ status: 'ok', value: choices[idx], index: idx, attempts });
              return;
            }
          }
          const asNum = Number.parseInt(v, 10);
          if (Number.isFinite(asNum) && asNum >= 1 && asNum <= choices.length) {
            this.pendingCancel = null;
            resolve({ status: 'ok', value: choices[asNum - 1], index: asNum - 1, attempts });
            return;
          }
          const direct = choices.findIndex(c => c.toLowerCase() === v.toLowerCase());
          if (direct >= 0) {
            this.pendingCancel = null;
            resolve({ status: 'ok', value: choices[direct], index: direct, attempts });
            return;
          }
          if (attempts >= (req.maxAttempts ?? 3)) {
            this.pendingCancel = null;
            resolve({ status: 'closed', attempts });
            return;
          }
          this.host.emit(`Invalid selection. Choose between 1 and ${choices.length}.`);
          ask(req.prompt);
        });
      };
      this.pendingCancel = () => {
        this.host.cancelRequest();
        resolve({ status: 'cancelled', attempts });
      };
      ask(req.prompt);
    });
  }

  private runMultiline(req: InputRequest): Promise<MultilineResult> {
    return new Promise(resolve => {
      const collected: string[] = [];
      const sentinel = req.until ?? '';
      const max = req.maxAttempts ?? 1_000;
      let asked = 0;

      const ask = () => {
        if (asked >= max) {
          this.pendingCancel = null;
          resolve({ status: 'ok', lines: collected, attempts: asked });
          return;
        }
        const prompt = asked === 0 ? req.prompt : '> ';
        this.host.requestInput({ ...req, prompt, kind: 'text', mask: false, echo: true }, (outcome) => {
          asked++;
          if (outcome.status === 'cancelled') {
            this.pendingCancel = null;
            resolve({ status: 'cancelled', attempts: asked });
            return;
          }
          if (outcome.status !== 'submitted') {
            this.pendingCancel = null;
            resolve({ status: outcome.status, lines: collected, attempts: asked });
            return;
          }
          const v = outcome.value;
          if (v === sentinel) {
            this.pendingCancel = null;
            resolve({ status: 'ok', lines: collected, attempts: asked });
            return;
          }
          collected.push(v);
          ask();
        });
      };
      this.pendingCancel = () => {
        this.host.cancelRequest();
        resolve({ status: 'cancelled', attempts: asked });
      };
      ask();
    });
  }
}
