import type { PSValue } from '../PSEnvironment';
import { PSRuntimeError } from '../PSRuntimeError';
import { registerPSDisplayFormatter } from '../PSExpansion';
import { makeExceptionObject } from './PSExceptions';

export type StreamKind = 'error' | 'warning' | 'verbose' | 'debug' | 'information';

export interface StreamCollector {
  readonly kind: StreamKind;
  readonly items: PSValue[];
}

export type StreamSink = (kind: StreamKind, record: PSValue) => void;

export type RedirectHandler = (record: PSValue, lines: readonly string[]) => boolean;

export const ACTION_PREFERENCES = ['SilentlyContinue', 'Stop', 'Continue', 'Inquire', 'Ignore', 'Suspend', 'Break'] as const;
export type ActionPreferenceName = typeof ACTION_PREFERENCES[number];

const RECORD_TYPES: Readonly<Record<'warning' | 'verbose' | 'debug', string>> = {
  warning: 'System.Management.Automation.WarningRecord',
  verbose: 'System.Management.Automation.VerboseRecord',
  debug: 'System.Management.Automation.DebugRecord',
};

const INFORMATION_RECORD = 'System.Management.Automation.InformationRecord';

const DISPLAY_PREFIX: Readonly<Record<'warning' | 'verbose' | 'debug', string>> = {
  warning: 'WARNING: ',
  verbose: 'VERBOSE: ',
  debug: 'DEBUG: ',
};

for (const type of [...Object.values(RECORD_TYPES), INFORMATION_RECORD]) {
  registerPSDisplayFormatter(type, record => String(record.Message ?? ''));
}

export function actionPreferenceOf(value: PSValue): ActionPreferenceName | null {
  const wanted = String(value ?? '').trim().toLowerCase();
  return ACTION_PREFERENCES.find(name => name.toLowerCase() === wanted) ?? null;
}

export function messageRecord(kind: 'warning' | 'verbose' | 'debug', message: string): PSValue {
  return { __type: RECORD_TYPES[kind], Message: message } as Record<string, PSValue>;
}

export function informationRecord(data: PSValue, tags: readonly string[], source: string, computer: string): PSValue {
  const text = Array.isArray(data) ? data.map(String).join(' ') : String(data ?? '');
  return {
    __type: INFORMATION_RECORD,
    Message: text,
    MessageData: data,
    Source: source,
    TimeGenerated: new Date(),
    Tags: [...tags],
    User: '',
    Computer: computer,
    ProcessId: 0,
    NativeThreadId: 0,
    ManagedThreadId: 1,
  } as Record<string, PSValue>;
}

export function displayLine(kind: 'warning' | 'verbose' | 'debug', message: string): string {
  return `${DISPLAY_PREFIX[kind]}${message}`;
}

export interface ErrorRecordSpec {
  readonly message: string;
  readonly exceptionType: string;
  readonly fullyQualifiedErrorId: string;
  readonly category?: string;
  readonly targetObject?: PSValue;
}

export function newErrorRecord(spec: ErrorRecordSpec): Record<string, PSValue> {
  return {
    Message: spec.message,
    Exception: makeExceptionObject(spec.exceptionType, spec.message) as unknown as PSValue,
    CategoryInfo: { Category: spec.category ?? 'NotSpecified' } as Record<string, PSValue>,
    TargetObject: spec.targetObject ?? null,
    FullyQualifiedErrorId: spec.fullyQualifiedErrorId,
  } as Record<string, PSValue>;
}

export function preferenceStopError(preferenceName: string, message: string): PSRuntimeError {
  return new PSRuntimeError(
    `The running command stopped because the preference variable "${preferenceName}" or common parameter is set to Stop: ${message}`,
    'System.Management.Automation.ActionPreferenceStopException');
}

export class StreamHub {
  private readonly collectors: StreamCollector[] = [];
  private hiddenBelow = 0;
  private readonly thrownRecords = new WeakMap<object, PSValue>();
  sink: StreamSink | null = null;
  linesWritten = 0;
  private readonly redirects: Array<Map<StreamKind, RedirectHandler>> = [];

  constructor(
    private readonly writeLine: (line: string) => void,
    private readonly errorHistory: { get(): PSValue[]; set(list: PSValue[]): void },
  ) {}

  open(kind: StreamKind): StreamCollector {
    const collector: StreamCollector = { kind, items: [] };
    this.collectors.push(collector);
    return collector;
  }

  close(collector: StreamCollector): void {
    const index = this.collectors.indexOf(collector);
    if (index >= 0) this.collectors.splice(index, 1);
  }

  collect(kind: StreamKind, record: PSValue): void {
    for (let index = this.hiddenBelow; index < this.collectors.length; index++) {
      const collector = this.collectors[index];
      if (collector.kind === kind) collector.items.push(record);
    }
  }

  hideEnclosingCollectors(): () => void {
    const previous = this.hiddenBelow;
    this.hiddenBelow = this.collectors.length;
    return () => { this.hiddenBelow = previous; };
  }

  recordError(record: PSValue): void {
    this.errorHistory.set([record, ...this.errorHistory.get()]);
    this.collect('error', record);
  }

  recordThrown(error: unknown, build: () => PSValue): PSValue {
    if (typeof error !== 'object' || error === null) return build();
    const known = this.thrownRecords.get(error);
    if (known !== undefined) return known;
    const record = build();
    this.thrownRecords.set(error, record);
    this.recordError(record);
    return record;
  }

  wasRecorded(error: unknown): boolean {
    return typeof error === 'object' && error !== null && this.thrownRecords.has(error);
  }

  pushRedirects(handlers: Map<StreamKind, RedirectHandler>): void {
    this.redirects.push(handlers);
  }

  popRedirects(): void {
    this.redirects.pop();
  }

  deliver(kind: StreamKind, record: PSValue, lines: readonly string[], shown = true): void {
    for (let index = this.redirects.length - 1; index >= 0; index--) {
      const handler = this.redirects[index].get(kind);
      if (handler !== undefined && handler(record, lines)) return;
    }
    if (this.sink !== null) this.sink(kind, record);
    else if (shown) for (const line of lines) { this.writeLine(line); this.linesWritten++; }
  }
}
