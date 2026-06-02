import type {
  InputRequest, StreamAttachment, StreamAttachOptions, InputCapabilities,
} from './types';

export type InputCompletion =
  | { readonly status: 'submitted'; readonly value: string }
  | { readonly status: 'cancelled' }
  | { readonly status: 'timeout' }
  | { readonly status: 'closed' };

export interface InputHost {
  requestInput(req: InputRequest, complete: (outcome: InputCompletion) => void): void;
  cancelRequest(): void;
  attachStream(opts: StreamAttachOptions): StreamAttachment;
  detachAllStreams(): void;
  emit(line: string): void;
  capabilities(): InputCapabilities;
}

export const NULL_INPUT_HOST: InputHost = {
  requestInput(_req, complete) { complete({ status: 'closed' }); },
  cancelRequest() {},
  attachStream(opts) {
    const id = `inert-${Math.random().toString(36).slice(2, 8)}`;
    let active = true;
    return {
      id,
      description: opts.description,
      get active() { return active; },
      cancel() { if (!active) return; active = false; opts.onCancel?.(); },
    };
  },
  detachAllStreams() {},
  emit(_line) {},
  capabilities() {
    return { interactive: false, maskedSupported: false, streaming: false };
  },
};
