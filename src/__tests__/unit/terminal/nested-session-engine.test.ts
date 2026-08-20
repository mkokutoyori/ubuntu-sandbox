import { describe, it, expect, beforeEach } from 'vitest';
import { TerminalSession, type KeyEvent, type InputMode, type TerminalTheme, type SessionType } from '@/terminal/sessions/TerminalSession';
import type { IOutputFormatter } from '@/terminal/core/OutputFormatter';
import type { Equipment } from '@/network';
import type { TextSegment } from '@/terminal/core/types';

const fakeDevice = { getName: () => 'dev', getIsPoweredOn: () => true } as unknown as Equipment;

class StubSession extends TerminalSession {
  constructor(id: string, private readonly vendor: SessionType) {
    super(id, fakeDevice);
  }
  protected handleModeKey(): boolean { return false; }
  protected getFlowFormatter(): IOutputFormatter { return {} as IOutputFormatter; }
  protected onEnter(): void { /* unused */ }
  protected onTab(): void { /* unused */ }
  getPrompt(): string { return `${this.vendor}$ `; }
  getTheme(): TerminalTheme {
    return {
      sessionType: this.vendor, backgroundColor: '#000', textColor: '#fff', errorColor: '#f00',
      promptColor: '#fff', fontFamily: 'monospace', infoBarBg: '#222', infoBarText: '#fff', infoBarBorder: '#333',
    };
  }
  getSessionType(): SessionType { return this.vendor; }
  getInfoBarContent(): { left: string } { return { left: this.vendor }; }
  async init(): Promise<void> { /* no boot */ }
  pressKey(e: KeyEvent): boolean { return this.handleKey(e); }
  get mode(): InputMode { return this.inputMode; }
}

describe('Nested-session engine — shared scrollback + foreground', () => {
  let host: StubSession;
  let child: StubSession;

  beforeEach(() => {
    host = new StubSession('host', 'windows');
    child = new StubSession('child', 'linux');
  });

  it('child output lands in the host buffer, not its own', () => {
    child.attachAsChildOf(host);
    child.addLine('remote line');
    expect(host.lines.map((l) => l.text)).toContain('remote line');
    expect(child.lines.length).toBe(0);
  });

  it('foreground is the active child while attached, the host once detached', () => {
    expect(host.foreground).toBe(host);
    child.attachAsChildOf(host);
    expect(host.foreground).toBe(child);
    child.detachFromHost();
    expect(host.foreground).toBe(host);
  });

  it('nested children all render into the root and foreground walks to the deepest', () => {
    const mid = new StubSession('mid', 'linux');
    const leaf = new StubSession('leaf', 'cisco');
    mid.attachAsChildOf(host);
    leaf.attachAsChildOf(mid);
    expect(host.foreground).toBe(leaf);
    leaf.addLine('deep');
    expect(host.lines.map((l) => l.text)).toContain('deep');
    expect(mid.lines.length).toBe(0);
    expect(leaf.lines.length).toBe(0);
    leaf.detachFromHost();
    expect(host.foreground).toBe(mid);
  });

  it('cross-vendor output drops producer styling so the host keeps its look', () => {
    child.attachAsChildOf(host);
    const segs: TextSegment[] = [{ text: 'Documents', style: { color: '#3465a4', bold: true } }];
    child.addStyledLine(segs);
    const line = host.lines.find((l) => l.text === 'Documents');
    expect(line).toBeDefined();
    expect(line!.segments).toBeUndefined();
  });

  it('same-vendor output keeps its styling', () => {
    const linuxHost = new StubSession('lh', 'linux');
    const linuxChild = new StubSession('lc', 'linux');
    linuxChild.attachAsChildOf(linuxHost);
    const segs: TextSegment[] = [{ text: 'Documents', style: { color: '#3465a4', bold: true } }];
    linuxChild.addStyledLine(segs);
    const line = linuxHost.lines.find((l) => l.text === 'Documents');
    expect(line!.segments).toBeDefined();
  });

  it('a child notify re-renders the host (shared React binding)', () => {
    let hostTicks = 0;
    host.subscribe(() => { hostTicks++; });
    child.attachAsChildOf(host);
    const before = hostTicks;
    child.addLine('x');
    expect(hostTicks).toBeGreaterThan(before);
  });
});
