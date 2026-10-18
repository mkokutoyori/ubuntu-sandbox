import type { PSValue } from './PSEnvironment';
import { psValueToString } from './PSExpansion';
import { PSRuntimeError } from './PSRuntimeError';

export interface HostSession {
  invokeScriptText(code: string): PSValue[];
  setVariable(name: string, value: PSValue): void;
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

export function createPowerShellHost(openSession: () => HostSession): Record<string, PSValue> {
  const items: HostItem[] = [];
  let session: HostSession | null = null;
  let serial = 0;
  const streams = { Error: [] as PSValue[], Warning: [] as PSValue[], Verbose: [] as PSValue[], Debug: [] as PSValue[], Information: [] as PSValue[], Progress: [] as PSValue[] };
  const host: Record<string, PSValue> = {};
  const lastCommand = (): Extract<HostItem, { kind: 'command' }> => {
    const last = items[items.length - 1];
    if (last === undefined || last.kind !== 'command') {
      throw new PSRuntimeError('A parameter or argument can only be added after a command.', 'System.InvalidOperationException');
    }
    return last;
  };
  Object.assign(host, {
    AddScript: (text: PSValue) => { items.push({ kind: 'script', text: psValueToString(text) }); return host; },
    AddCommand: (name: PSValue) => { items.push({ kind: 'command', name: psValueToString(name), parameters: [], arguments: [] }); return host; },
    AddParameter: (name: PSValue, value?: PSValue) => { lastCommand().parameters.push([psValueToString(name), value === undefined ? true : value]); return host; },
    AddArgument: (value: PSValue) => { lastCommand().arguments.push(value); return host; },
    AddStatement: () => { items.push({ kind: 'statement' }); return host; },
    Commands: { Clear: () => { items.length = 0; return null; } },
    Invoke: (input?: PSValue) => {
      session ??= openSession();
      const active = session;
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
        throw error;
      }
      return outputs;
    },
    Dispose: () => null,
    Stop: () => null,
    HadErrors: false,
    Streams: streams,
  });
  return host;
}
