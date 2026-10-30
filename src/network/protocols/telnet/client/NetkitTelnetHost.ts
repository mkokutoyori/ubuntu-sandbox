export interface NetkitTelnetTransport {
  write(data: string): void;
  close(): void;
  onData(handler: (data: string) => void): () => void;
  onClose?(handler: (reason: string) => void): () => void;
}

export interface NetkitResolution {
  readonly ok: boolean;
  readonly addresses: readonly NetkitAddress[];
  readonly port: number;
  readonly canonicalName: string | null;
  readonly message: string;
  readonly noName: boolean;
}

export function resolved(addresses: readonly NetkitAddress[], port: number, canonicalName: string | null): NetkitResolution {
  return { ok: true, addresses, port, canonicalName, message: '', noName: false };
}

export function unresolved(message: string, noName: boolean): NetkitResolution {
  return { ok: false, addresses: [], port: 0, canonicalName: null, message, noName };
}

export interface NetkitAddress {
  readonly text: string;
  readonly family: 4 | 6;
}

export interface NetkitConnection {
  readonly connected: boolean;
  readonly transport: NetkitTelnetTransport | null;
  readonly reason: string;
}

export function established(transport: NetkitTelnetTransport): NetkitConnection {
  return { connected: true, transport, reason: '' };
}

export function refused(reason: string): NetkitConnection {
  return { connected: false, transport: null, reason };
}

export interface NetkitTelnetHost {
  environment(): ReadonlyArray<readonly [string, string]>;
  currentUser(): { readonly name: string; readonly uid: number } | null;
  terminalSize(): { readonly rows: number; readonly cols: number } | null;
  terminalSpeed(): { readonly input: number; readonly output: number };
  hostname(): string;
  isTty(): boolean;
  suspend?(): void;
  canonicalHostname(name: string): string;
  lookupUser(name: string): { readonly uid: number } | null;
  readFile(path: string): string | null;
  resolve(host: string, service: string, family: 0 | 4 | 6, numericOnly: boolean): NetkitResolution;
  connect(address: NetkitAddress, port: number, source: NetkitAddress | null): Promise<NetkitConnection>;
}

export interface NetkitTerminalMode {
  readonly commandLine: boolean;
  readonly echo: boolean;
  readonly flow: boolean;
  readonly trapSignals: boolean;
  readonly edit: boolean;
  readonly softTabs: boolean;
  readonly literalEcho: boolean;
  readonly inputBinary: boolean;
  readonly outputBinary: boolean;
  readonly output8: boolean;
  readonly escape: number;
  readonly crlf: boolean;
}

export interface NetkitTelnetTerminal {
  write(text: string): void;
  error(text: string): void;
  setMode(mode: NetkitTerminalMode): void;
}
