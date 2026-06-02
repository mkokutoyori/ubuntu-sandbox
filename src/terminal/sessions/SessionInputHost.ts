import type {
  InputHost, InputCompletion, InputCapabilities,
  StreamAttachOptions, StreamAttachment,
} from '@/shell/input';
import type { InputRequest } from '@/shell/input/types';

export interface InputHostBindings {
  setInputMode(mode: 'password' | 'interactive-text', promptText: string): void;
  clearInputMode(): void;
  emit(line: string): void;
  notify(): void;
  isDisposed(): boolean;
}

interface InternalAttachment extends StreamAttachment {
  detach(): void;
}

export class SessionInputHost implements InputHost {
  private pendingComplete: ((outcome: InputCompletion) => void) | null = null;
  private pendingRequest: InputRequest | null = null;
  private readonly streams = new Map<string, InternalAttachment>();
  private nextStreamId = 1;

  constructor(private readonly bindings: InputHostBindings) {}

  hasPendingRequest(): boolean { return this.pendingComplete !== null; }
  getPendingRequest(): InputRequest | null { return this.pendingRequest; }

  submitPending(value: string): boolean {
    const cb = this.pendingComplete;
    if (!cb) return false;
    this.pendingComplete = null;
    this.pendingRequest = null;
    this.bindings.clearInputMode();
    cb({ status: 'submitted', value });
    return true;
  }

  cancelPending(): boolean {
    const cb = this.pendingComplete;
    if (!cb) return false;
    this.pendingComplete = null;
    this.pendingRequest = null;
    this.bindings.clearInputMode();
    cb({ status: 'cancelled' });
    return true;
  }

  hasActiveStream(): boolean { return this.streams.size > 0; }
  listStreams(): readonly StreamAttachment[] { return [...this.streams.values()]; }

  detachAllStreams(): void {
    const list = [...this.streams.values()];
    for (const s of list) s.cancel();
  }

  requestInput(req: InputRequest, complete: (outcome: InputCompletion) => void): void {
    if (this.bindings.isDisposed()) { complete({ status: 'closed' }); return; }
    if (this.pendingComplete) this.cancelPending();
    this.pendingComplete = complete;
    this.pendingRequest = req;
    const mode: 'password' | 'interactive-text' =
      req.kind === 'password' || req.mask === true || req.echo === false ? 'password' : 'interactive-text';
    this.bindings.setInputMode(mode, req.prompt);
    this.bindings.notify();
  }

  cancelRequest(): void { this.cancelPending(); }

  attachStream(opts: StreamAttachOptions): StreamAttachment {
    const id = `s${this.nextStreamId++}`;
    let active = true;
    const attachment: InternalAttachment = {
      id,
      description: opts.description,
      get active() { return active; },
      cancel: () => { if (!active) return; active = false; this.streams.delete(id); opts.onCancel?.(); this.bindings.notify(); },
      detach: () => { active = false; this.streams.delete(id); },
    };
    this.streams.set(id, attachment);
    this.bindings.notify();
    return attachment;
  }

  emit(line: string): void {
    this.bindings.emit(line);
    this.bindings.notify();
  }

  capabilities(): InputCapabilities {
    return {
      interactive: !this.bindings.isDisposed(),
      maskedSupported: true,
      streaming: true,
    };
  }
}
