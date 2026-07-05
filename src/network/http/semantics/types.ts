export class OrderedMultimap<V = string> {
  private entriesList: Array<[string, V]> = [];

  append(key: string, value: V): void {
    this.entriesList.push([key, value]);
  }

  set(key: string, value: V): void {
    const lower = key.toLowerCase();
    this.entriesList = this.entriesList.filter(([k]) => k.toLowerCase() !== lower);
    this.entriesList.push([key, value]);
  }

  get(key: string): V | undefined {
    const lower = key.toLowerCase();
    const found = this.entriesList.find(([k]) => k.toLowerCase() === lower);
    return found?.[1];
  }

  getAll(key: string): V[] {
    const lower = key.toLowerCase();
    return this.entriesList.filter(([k]) => k.toLowerCase() === lower).map(([, v]) => v);
  }

  has(key: string): boolean {
    const lower = key.toLowerCase();
    return this.entriesList.some(([k]) => k.toLowerCase() === lower);
  }

  delete(key: string): boolean {
    const lower = key.toLowerCase();
    const before = this.entriesList.length;
    this.entriesList = this.entriesList.filter(([k]) => k.toLowerCase() !== lower);
    return this.entriesList.length !== before;
  }

  entries(): Array<[string, V]> {
    return [...this.entriesList];
  }

  keys(): string[] {
    const seen = new Set<string>();
    const result: string[] = [];
    for (const [k] of this.entriesList) {
      const lower = k.toLowerCase();
      if (!seen.has(lower)) {
        seen.add(lower);
        result.push(k);
      }
    }
    return result;
  }

  get size(): number {
    return this.entriesList.length;
  }

  [Symbol.iterator](): Iterator<[string, V]> {
    return this.entriesList[Symbol.iterator]();
  }
}

export type HttpMethod = 'GET' | 'HEAD' | 'POST' | 'PUT' | 'DELETE' | 'CONNECT' | 'OPTIONS' | 'TRACE' | 'PATCH';

export interface MethodProperties {
  safe: boolean;
  idempotent: boolean;
  cacheableByDefault: boolean;
}

export interface HttpMessage {
  kind: 'request' | 'response';
  method?: HttpMethod;
  target?: string;
  statusCode?: number;
  reasonPhrase?: string;
  headers: OrderedMultimap<string>;
  body: Uint8Array | null;
  httpVersion: '1.1' | '2' | '3';
}

export function createRequest(method: HttpMethod, target: string, httpVersion: HttpMessage['httpVersion'] = '1.1'): HttpMessage {
  return { kind: 'request', method, target, headers: new OrderedMultimap<string>(), body: null, httpVersion };
}

export function createResponse(statusCode: number, reasonPhrase: string, httpVersion: HttpMessage['httpVersion'] = '1.1'): HttpMessage {
  return { kind: 'response', statusCode, reasonPhrase, headers: new OrderedMultimap<string>(), body: null, httpVersion };
}
