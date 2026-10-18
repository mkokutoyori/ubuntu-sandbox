import type { PSValue } from './PSEnvironment';
import { psValueToString } from './PSExpansion';
import { PSRuntimeError } from './PSRuntimeError';
import type { StreamKind, StreamSink } from './semantics/PSStreams';

export interface HostSession {
  invokeScriptText(code: string): PSValue[];
  setVariable(name: string, value: PSValue): void;
  errorRecord(error: unknown): PSValue;
  captureStreams(sink: StreamSink): void;
}

const STREAM_NAMES: Readonly<Record<StreamKind, string>> = {
  error: 'Error', warning: 'Warning', verbose: 'Verbose', debug: 'Debug', information: 'Information',
};

export function createRunspace(): Record<string, PSValue> {
  const state: Record<string, PSValue> = { State: 'BeforeOpen' };
  return {
    RunspaceStateInfo: state,
    Open: () => { state.State = 'Opened'; return null; },
    Close: () => { state.State = 'Closed'; return null; },
    Dispose: () => { state.State = 'Closed'; return null; },
  };
}

function makeList(): PSValue[] {
  const list: PSValue[] = [];
  Object.defineProperty(list, '__list__', { value: true, enumerable: false });
  return list;
}

type HostItem =
  | { readonly kind: 'statement' }
  | { readonly kind: 'script'; readonly text: string }
  | { readonly kind: 'command'; readonly name: string; readonly parameters: Array<[string, PSValue]>; readonly arguments: PSValue[] };

function commandLine(item: Extract<HostItem, { kind: 'command' }>, session: HostSession, serial: number, piped: boolean): string {
  const parts = [`${piped ? '$input | ' : ''}& '${item.name.replace(/'/g, "''")}'`];
  item.parameters.forEach(([name, value], index) => {
    const variable = `__hostParameter${serial}_${index}`;
    session.setVariable(variable, value);
    parts.push(`-${name}:$${variable}`);
  });
  item.arguments.forEach((value, index) => {
    const variable = `__hostArgument${serial}_${index}`;
    session.setVariable(variable, value);
    parts.push(`$${variable}`);
  });
  return parts.join(' ');
}

type PendingInvocation = { readonly outputs: PSValue[] } | { readonly failure: unknown };

export function createPowerShellHost(openSession: () => HostSession): Record<string, PSValue> {
  const items: HostItem[] = [];
  let session: HostSession | null = null;
  let serial = 0;
  const streams = { Error: makeList(), Warning: makeList(), Verbose: makeList(), Debug: makeList(), Information: makeList(), Progress: makeList() };
  const lists = Object.values(streams);
  Object.assign(streams, { ClearStreams: () => { for (const list of lists) list.length = 0; return null; } });
  const state: Record<string, PSValue> = { State: 'NotStarted' };
  const host: Record<string, PSValue> = {};
  const lastCommand = (): Extract<HostItem, { kind: 'command' }> => {
    const last = items[items.length - 1];
    if (last === undefined || last.kind !== 'command') {
      throw new PSRuntimeError('A parameter or argument can only be added after a command.', 'System.InvalidOperationException');
    }
    return last;
  };
  const invoke = (input?: PSValue): PSValue[] => {
    if (session === null) {
      session = openSession();
      session.captureStreams((kind, record) => {
        streams[STREAM_NAMES[kind] as keyof typeof streams].push(record);
        if (kind === 'error') host.HadErrors = true;
      });
    }
    const active = session;
    host.HadErrors = false;
    state.State = 'Running';
    if (input !== undefined && input !== null) active.setVariable('input', input);
    const outputs: PSValue[] = [];
    try {
      let carried: PSValue[] | null = null;
      for (const item of items) {
        if (item.kind === 'statement') {
          if (carried !== null) outputs.push(...carried);
          carried = null;
          continue;
        }
        if (carried !== null) active.setVariable('input', carried);
        const text = item.kind === 'script' ? item.text : commandLine(item, active, serial++, carried !== null);
        carried = active.invokeScriptText(text);
      }
      if (carried !== null) outputs.push(...carried);
    } catch (error) {
      host.HadErrors = true;
      const fatal = !(error instanceof PSRuntimeError) || error.thrownFromThrowStatement
        || error.exceptionType.endsWith('.ActionPreferenceStopException');
      if (fatal) {
        state.State = 'Failed';
        throw error;
      }
      streams.Error.push(active.errorRecord(error));
    }
    state.State = 'Completed';
    return outputs;
  };
  let pending: PendingInvocation | null = null;
  Object.assign(host, {
    AddScript: (text: PSValue) => { items.push({ kind: 'script', text: psValueToString(text) }); return host; },
    AddCommand: (name: PSValue) => { items.push({ kind: 'command', name: psValueToString(name), parameters: [], arguments: [] }); return host; },
    AddParameter: (name: PSValue, value?: PSValue) => { lastCommand().parameters.push([psValueToString(name), value === undefined ? true : value]); return host; },
    AddArgument: (value: PSValue) => { lastCommand().arguments.push(value); return host; },
    AddStatement: () => { items.push({ kind: 'statement' }); return host; },
    Commands: { Clear: () => { items.length = 0; return null; } },
    Invoke: (input?: PSValue) => invoke(input),
    BeginInvoke: (input?: PSValue) => {
      try { pending = { outputs: invoke(input) }; } catch (failure) { pending = { failure }; }
      return { IsCompleted: true, AsyncState: null } as Record<string, PSValue>;
    },
    EndInvoke: () => {
      const result: PendingInvocation | null = pending;
      pending = null;
      if (result === null) return [];
      if ('failure' in result) throw result.failure;
      return result.outputs;
    },
    Dispose: () => null,
    Stop: () => null,
    HadErrors: false,
    InvocationStateInfo: state,
    Streams: streams,
  });
  return host;
}
