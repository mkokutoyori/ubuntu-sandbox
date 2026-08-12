import { describe, it, expect, beforeEach } from 'vitest';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { CiscoTerminalSession } from '@/terminal/sessions';
import { TerminalManager } from '@/terminal/sessions/TerminalManager';
import { EventBus, __setDefaultEventBus } from '@/events/EventBus';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import type { KeyEvent } from '@/terminal/sessions/TerminalSession';

const key = (k: string): KeyEvent =>
  ({ key: k, ctrlKey: false, shiftKey: false, altKey: false, metaKey: false }) as KeyEvent;

let bus: EventBus;
let manager: TerminalManager;

beforeEach(() => {
  EquipmentRegistry.resetInstance();
  bus = new EventBus();
  __setDefaultEventBus(bus);
  EquipmentRegistry.getInstance().setEventBus(bus);
  manager = new TerminalManager(bus);
});

async function bootedConsole(): Promise<{ router: CiscoRouter; session: CiscoTerminalSession }> {
  const router = new CiscoRouter('Router1', 0, 0);
  router.setEventBus(bus);
  router.powerOn();
  const session = manager.getSession(manager.openTerminal(router)!) as CiscoTerminalSession;
  for (let i = 0; i < 400 && session.isBooting; i++) {
    await new Promise((r) => setTimeout(r, 10));
  }
  return { router, session };
}

async function type(session: CiscoTerminalSession, line: string): Promise<void> {
  if (session.currentInputMode.type === 'normal') session.setInput(line);
  else session.insertText(line);
  session.handleKey(key('Enter'));
  for (let i = 0; i < 60; i++) await new Promise((r) => setTimeout(r, 0));
}

const screen = (s: CiscoTerminalSession): string => s.lines.map((l) => l.text).join('\n');

describe('the boot transcript states nothing the machine did not do', () => {
  it('the setup dialog is not printed with its own answer', async () => {
    const { session } = await bootedConsole();
    const text = screen(session);
    expect(text, 'the router answered its own question')
      .not.toContain('Would you like to enter the initial configuration dialog?');
    expect(text).toContain('Press RETURN to get started.');
  });

  it('the boot ends on the configuration register, then the RETURN notice', async () => {
    const { session } = await bootedConsole();
    const lines = screen(session).trimEnd().split('\n');
    const tail = lines.slice(-3).map((l) => l.trim());
    expect(tail[0]).toMatch(/^Configuration register is 0x[0-9a-f]+$/);
    expect(tail[1]).toBe('');
    expect(tail[2]).toBe('Press RETURN to get started.');
  });
});

describe('`Press RETURN to get started.` really waits for RETURN', () => {
  it('no prompt is drawn until the operator presses it', async () => {
    const { session } = await bootedConsole();
    expect(session.getPrompt()).toBe('');

    session.handleKey(key('Enter'));
    for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 0));
    expect(session.getPrompt()).toBe('Router1>');
  });

  it('that RETURN runs no command — it only brings the prompt up', async () => {
    const { router, session } = await bootedConsole();
    session.handleKey(key('Enter'));
    for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 0));
    expect(screen(session)).not.toMatch(/% (Invalid|Incomplete|Unknown)/);
    expect(await router.executeCommand('show privilege')).toContain('level is 1');
  });

  it('a command typed straight away still runs — the line is live, only the prompt waits', async () => {
    const { session } = await bootedConsole();
    await type(session, 'enable');
    expect(session.getPrompt()).toBe('Router1#');
  });
});

describe('leaving the console does not log a session nobody opened', () => {
  it('`exit` on an unauthenticated console logs no LOGOUT line', async () => {
    const { router, session } = await bootedConsole();
    await type(session, 'enable');
    await type(session, 'exit');

    expect(screen(session)).not.toContain('%SYS-6-LOGOUT');
    expect(screen(session)).not.toContain('0.0.0.0');
    expect(await router.executeCommand('show logging')).not.toContain('LOGOUT');
  });

  it('the console is offered again instead of the window disappearing', async () => {
    const { router, session } = await bootedConsole();
    await type(session, 'enable');
    await type(session, 'exit');
    expect(screen(session)).toContain('Router1 con0 is now available');
    expect(screen(session)).toContain('Press RETURN to get started.');
    expect(session.disposed).toBe(false);
    expect(manager.getSessionsForDevice(router.getId())).toHaveLength(1);
  });
});

describe('`setup` runs the real dialog', () => {
  it('it asks instead of answering for the operator', async () => {
    const { session } = await bootedConsole();
    await type(session, 'enable');
    await type(session, 'setup');
    expect(screen(session)).toContain('--- System Configuration Dialog ---');
    expect(session.currentInputMode).toMatchObject({
      type: 'interactive-text',
      promptText: 'Continue with configuration dialog? [yes/no]: ',
    });
  });

  it('declining returns to the prompt without configuring anything', async () => {
    const { router, session } = await bootedConsole();
    await type(session, 'enable');
    await type(session, 'setup');
    await type(session, 'no');
    expect(session.currentInputMode.type).toBe('normal');
    expect(await router.executeCommand('show running-config')).not.toContain('enable secret');
  });

  it('accepting walks the global parameters, naming this router in the default', async () => {
    const { session } = await bootedConsole();
    await type(session, 'enable');
    await type(session, 'setup');
    await type(session, 'yes');
    expect(screen(session)).toContain('Configuring global parameters:');
    expect(session.currentInputMode).toMatchObject({
      promptText: '  Enter host name [Router1]: ',
    });
  });

  it('it offers each real interface of the chassis, by name', async () => {
    const router = new CiscoRouter('Router1', 0, 0);
    router.setEventBus(bus);
    router.powerOn();
    const names = router.getPorts().map((p) => p.getName());
    const session = manager.getSession(manager.openTerminal(router)!) as CiscoTerminalSession;
    for (let i = 0; i < 400 && session.isBooting; i++) {
      await new Promise((r) => setTimeout(r, 10));
    }
    await type(session, 'enable');
    await type(session, 'setup');
    await type(session, 'yes');
    for (const answer of ['LabRouter', 'Secret123', '', 'VtyPass']) await type(session, answer);

    expect(session.currentInputMode).toMatchObject({
      promptText: `Do you want to configure ${names[0]} interface? [no]: `,
    });
  });

  it('what it collects is applied by the real commands', async () => {
    const { router, session } = await bootedConsole();
    const names = router.getPorts().map((p) => p.getName());
    await type(session, 'enable');
    await type(session, 'setup');
    await type(session, 'yes');
    for (const answer of ['LabRouter', 'Secret123', '', 'VtyPass']) await type(session, answer);
    for (const _name of names) {
      await type(session, 'no');
      await type(session, 'no');
      await type(session, '');
      await type(session, '');
    }
    expect(screen(session)).toContain('The following configuration command script was created:');
    await type(session, '2');

    expect(await router.executeCommand('enable'),
      'the secret the dialog collected now guards the box').toBe('% Access denied');
    await router.executeCommand('enable', { passwordInput: 'Secret123' });
    const config = await router.executeCommand('show running-config');
    expect(config).toContain('hostname LabRouter');
    expect(config).toMatch(/enable secret 5 \$1\$/);
    expect(config).not.toContain('Secret123');
    expect(config).toContain('password VtyPass');
  });

  it('selection 0 leaves the configuration untouched', async () => {
    const { router, session } = await bootedConsole();
    const names = router.getPorts().map((p) => p.getName());
    await type(session, 'enable');
    await type(session, 'setup');
    await type(session, 'yes');
    for (const answer of ['LabRouter', 'Secret123', '', 'VtyPass']) await type(session, answer);
    for (const _name of names) {
      await type(session, 'no');
      await type(session, 'no');
      await type(session, '');
      await type(session, '');
    }
    await type(session, '0');

    const config = await router.executeCommand('show running-config');
    expect(config).not.toContain('hostname LabRouter');
    expect(config).not.toContain('enable secret');
  });
});
