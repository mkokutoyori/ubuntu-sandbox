import { jsonText } from '../Json';
import type { JsonValue } from '../Message';

export type StatisticsFormat = 'legacy' | 'json' | 'json-elasticsearch' | 'cee';

export const CEE_COOKIE = '@cee:';

export interface StatsCounterSpec {
  readonly name: string;
  readonly read: () => number;
  readonly reset?: () => void;
  readonly mustReset?: boolean;
}

export interface StatsObjectOptions {
  readonly origin?: string;
  readonly reportingNamespace?: string;
  readonly prepend?: boolean;
  readonly readNotifier?: () => void;
}

export class StatsObject {
  private counters: StatsCounterSpec[] = [];
  readonly origin: string | null;
  readonly reportingNamespace: string | null;
  readonly readNotifier: (() => void) | null;

  constructor(readonly name: string, readonly options: StatsObjectOptions) {
    this.origin = options.origin ?? null;
    this.reportingNamespace = options.reportingNamespace ?? null;
    this.readNotifier = options.readNotifier ?? null;
  }

  addCounter(spec: StatsCounterSpec): void {
    this.counters.push(spec);
  }

  clearCounters(): void {
    this.counters = [];
  }

  removeCounter(name: string): void {
    this.counters = this.counters.filter((counter) => counter.name !== name);
  }

  counterNames(): string[] {
    return this.counters.map((counter) => counter.name);
  }

  entries(resetCounters: boolean): Array<readonly [string, number]> {
    const values: Array<readonly [string, number]> = [];
    for (const counter of this.counters) {
      values.push([counter.name, counter.read()]);
      if ((resetCounters && counter.reset !== undefined) || counter.mustReset === true) counter.reset?.();
    }
    return values;
  }
}

function legacyLine(object: StatsObject, resetCounters: boolean): string {
  let line = `${object.name}: `;
  if (object.origin !== null) line += `origin=${object.origin} `;
  for (const [name, value] of object.entries(resetCounters)) line += `${name}=${value} `;
  return line;
}

function jsonLine(object: StatsObject, format: Exclude<StatisticsFormat, 'legacy'>, resetCounters: boolean): string {
  const root: { [key: string]: JsonValue } = { name: object.name };
  if (object.origin !== null) root.origin = object.origin;
  let values = root;
  if (object.reportingNamespace !== null) {
    values = {};
    root[object.reportingNamespace] = values;
  }
  for (const [name, value] of object.entries(resetCounters)) values[format === 'json-elasticsearch' ? name.replace(/\./g, '!') : name] = value;
  const text = jsonText(root);
  return format === 'cee' ? `${CEE_COOKIE} ${text}` : text;
}

export class Statistics {
  private objects: StatsObject[] = [];
  enabled = false;

  create(name: string, options: StatsObjectOptions = {}): StatsObject {
    const object = new StatsObject(name, options);
    if (options.prepend === true) this.objects.unshift(object);
    else this.objects.push(object);
    return object;
  }

  remove(object: StatsObject): void {
    this.objects = this.objects.filter((candidate) => candidate !== object);
  }

  find(name: string, origin: string | null = null): StatsObject | undefined {
    return this.objects.find((object) => object.name === name && (origin === null || object.origin === origin));
  }

  all(): readonly StatsObject[] {
    return this.objects;
  }

  lines(format: StatisticsFormat, resetCounters: boolean): string[] {
    const lines: string[] = [];
    for (const object of [...this.objects]) {
      lines.push(format === 'legacy' ? legacyLine(object, resetCounters) : jsonLine(object, format, resetCounters));
      object.readNotifier?.();
    }
    return lines;
  }
}
