import type { Equipment } from '@/network/equipment/Equipment';
import type { KeyEvent } from '@/terminal/sessions/TerminalSession';
import { findHostByAddress } from '@/network/devices/linux/network/HostLookup';
import { isDialFailure } from '@/network/tcp/types';
import { parseDialAddress, type DialAddress } from '@/network/tcp/dial';
import { PortNumber } from '@/network/core/ports/PortNumber';
import { IanaServiceRegistry } from '@/network/core/ports/IanaServiceRegistry';
import { wireReachOutcomeRetransmitting } from '@/terminal/ssh/wireSshLogin';
import { NetkitTelnetClient } from '@/network/protocols/telnet/client/NetkitTelnetClient';
import { DeviceNetkitHost, type DeviceNetkitDeps } from '@/network/protocols/telnet/client/DeviceNetkitHost';
import type { NetkitTelnetTerminal, NetkitTelnetTransport, NetkitTerminalMode } from '@/network/protocols/telnet/client/NetkitTelnetHost';
import type { ISubShell, SubShellKeyResult, SubShellResult } from './ISubShell';

const MAX_COLLECT_TICKS = 24;

const HIDDEN_PROMPT = /[Pp]assword:\s*$/;

export interface NetkitTelnetSimDeps extends Omit<DeviceNetkitDeps, 'tty'> {}

export function deviceWireDeps(
  device: Equipment, resolverVfs: { readFile(path: string): string | null } | undefined,
): Pick<DeviceNetkitDeps, 'lookupHost' | 'servicePort' | 'reach' | 'dial'> {
  const dialer = device as unknown as {
    tcpDial?: (d: DialAddress, p: PortNumber) => Promise<unknown>;
    tcpConnect?: (h: string, p: number) => Promise<NetkitTelnetTransport | null>;
  };
  return {
    lookupHost: (name) => findHostByAddress(name, resolverVfs, device)?.ip ?? null,
    servicePort: (name) => IanaServiceRegistry.standard().resolvePort(name, 'tcp') ?? null,
    reach: (ip, port) => wireReachOutcomeRetransmitting(device, ip, port),
    dial: async (ip, port) => {
      const destination = parseDialAddress(ip);
      const portNumber = PortNumber.of(port);
      const dialed = dialer.tcpDial && destination !== null && portNumber !== null
        ? await dialer.tcpDial.call(device, destination, portNumber)
        : dialer.tcpConnect
          ? await dialer.tcpConnect.call(device, ip, port)
          : null;
      if (!dialed) return null;
      if (isDialFailure(dialed)) return { dialFailed: String(dialed.dialFailed) };
      return dialed as NetkitTelnetTransport;
    },
  };
}

const utf8 = new TextEncoder();
const utf8Decoder = new TextDecoder('utf-8', { fatal: true });

function encodeInput(text: string): string {
  return String.fromCharCode(...utf8.encode(text));
}

function decodeOutput(bytes: string): string {
  const raw = Uint8Array.from(bytes, (c) => c.charCodeAt(0) & 0xff);
  try {
    return utf8Decoder.decode(raw);
  } catch {
    return bytes;
  }
}

class CapturingTerminal implements NetkitTelnetTerminal {
  text = '';
  mode: NetkitTerminalMode | null = null;

  write(text: string): void { this.text += text; }
  error(text: string): void { this.text += text; }
  setMode(mode: NetkitTerminalMode): void { this.mode = mode; }

  take(): string {
    const taken = this.text;
    this.text = '';
    return taken;
  }
}

export class NetkitTelnetSubShell implements ISubShell {
  readonly kind = 'telnet';
  readonly connection = 'telnet' as const;
  private readonly terminal = new CapturingTerminal();
  private readonly client: NetkitTelnetClient;
  private prompt = '';
  private exited = false;
  private size: { rows: number; cols: number } | null;

  constructor(private readonly deps: NetkitTelnetSimDeps, private readonly onEnd?: () => void) {
    this.size = deps.size() === null ? null : { ...(deps.size() as { rows: number; cols: number }) };
    const host = new DeviceNetkitHost({ ...deps, tty: true, size: () => this.size });
    this.client = new NetkitTelnetClient(host, this.terminal);
    this.client.onExit(() => { this.exited = true; });
  }

  getPrompt(): string { return this.prompt; }

  async begin(args: readonly string[]): Promise<SubShellResult> {
    await this.client.start(args);
    await this.client.idle();
    return this.render(await this.collect(), null);
  }

  resize(rows: number, cols: number): void {
    this.size = { rows, cols };
    this.client.signal('WINCH');
  }

  handleKey(): boolean {
    return false;
  }

  interceptKey(e: KeyEvent, pending: string): Promise<SubShellKeyResult> | null {
    if (!e.ctrlKey || e.altKey || e.metaKey || e.key.length !== 1 || this.exited) return null;
    const control = e.key.toUpperCase().charCodeAt(0) & 0x1f;
    if (this.client.currentState === 'command') {
      if (e.key.toLowerCase() === 'c') return this.deliver(() => this.client.signal('INT'));
      if (e.key.toLowerCase() === 'd' && pending === '') return this.deliver(() => this.client.inputEof());
      return null;
    }
    if (this.client.currentState !== 'session') return null;
    const canonical = this.client.lineEditing;
    if (control === this.client.escapeCharacter && this.client.escapeCharacter !== 0) {
      return this.deliver(() => this.client.input(this.send(pending, canonical, false) + String.fromCharCode(control)));
    }
    const trap = this.client.trapsSignals;
    if (trap && e.key.toLowerCase() === 'c') return this.deliver(() => this.client.signal('INT'));
    if (trap && e.key === '\\') return this.deliver(() => this.client.signal('QUIT'));
    if (trap && e.key.toLowerCase() === 'z') return this.deliver(() => this.client.signal('TSTP'));
    if (e.key.toLowerCase() === 'd' && canonical && pending === '') return this.deliver(() => this.client.inputEof());
    if (e.key.toLowerCase() === 'c' || e.key.toLowerCase() === 'd' || e.key.toLowerCase() === 'z' || e.key === '\\') {
      return this.deliver(() => this.client.input(this.send(pending, canonical, false) + String.fromCharCode(control)));
    }
    return null;
  }

  async processLine(line: string): Promise<SubShellResult> {
    if (this.exited) return this.finish([]);
    const state = this.client.currentState;
    const echoed = state === 'session' && !this.client.localEcho ? line : null;
    this.client.input(this.send(line, this.client.lineEditing || state === 'command', true));
    await this.client.idle();
    return this.render(await this.collect(), echoed);
  }

  async handleInput(value: string): Promise<SubShellResult> {
    if (this.exited) return this.finish([]);
    this.client.input(this.send(value, this.client.lineEditing || this.client.currentState === 'command', true));
    await this.client.idle();
    return this.render(await this.collect(), null);
  }

  dispose(): void {
    this.client.dispose();
    this.exited = true;
    this.onEnd?.();
  }

  private send(line: string, canonical: boolean, terminated: boolean): string {
    const encoded = encodeInput(line);
    if (!terminated) return encoded;
    return `${encoded}${canonical ? '\n' : '\r'}`;
  }

  private async deliver(action: () => void): Promise<SubShellKeyResult> {
    action();
    await this.client.idle();
    const result = this.render(await this.collect(), null);
    return { ...result, clearInput: true };
  }

  private async collect(): Promise<string> {
    let text = '';
    let sawData = false;
    for (let i = 0; i < MAX_COLLECT_TICKS; i++) {
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      const chunk = this.terminal.take();
      if (chunk) {
        text += chunk;
        sawData = true;
        continue;
      }
      if (sawData || this.exited) break;
    }
    return decodeOutput(text).replace(/\r\n/g, '\n').replace(/\r/g, '');
  }

  private render(raw: string, echoed: string | null): SubShellResult {
    const text = echoed === null ? raw : stripLeadingEcho(raw, echoed);
    const cut = text.lastIndexOf('\n');
    const body = cut >= 0 ? text.slice(0, cut) : '';
    this.prompt = cut >= 0 ? text.slice(cut + 1) : text;
    const output = body.length > 0 ? body.split('\n') : [];
    while (output.length > 0 && output[0] === '') output.shift();
    if (this.exited) {
      if (this.prompt) {
        output.push(this.prompt);
        this.prompt = '';
      }
      return this.finish(output);
    }
    const hidden = HIDDEN_PROMPT.test(this.prompt);
    return {
      output, exit: false, prompt: this.prompt,
      ...(hidden ? { pendingInput: { kind: 'password' as const, promptText: this.prompt } } : {}),
    };
  }

  private finish(output: string[]): SubShellResult {
    this.onEnd?.();
    return { output, exit: true, prompt: '' };
  }
}

function stripLeadingEcho(raw: string, echoed: string): string {
  const withNewline = `${echoed}\n`;
  if (raw.startsWith(withNewline)) return raw.slice(withNewline.length);
  if (echoed !== '' && raw.startsWith(echoed)) return raw.slice(echoed.length);
  if (raw.startsWith('\n')) return raw.slice(1);
  return raw;
}
