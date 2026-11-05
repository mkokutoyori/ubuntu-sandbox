/*
 * 'echo ... | sudo tee -a /etc/hosts' ran without ever showing the '[sudo] password for user:' prompt: the interaction planner only looked at a line that
 * STARTS with sudo, so a sudo further down a pipeline, after ';', '&&' or '||', was executed with no challenge and the password field of the terminal
 * never appeared. A real sudo reads its password from the terminal whatever the shell line around it, so the planner now plans the challenge for the
 * first such sudo (quoted text is not scanned; sudo -n, -S, -k, -K, -V and -h never prompt, and root is never asked) and runs the whole line once the
 * password is right; a wrong one gets 'Sorry, try again.' and the line does not run.
 *
 * Measured against the commit before (worktree): 5 of 8 cases fall. The 3 that pass either way are WITNESSES and non-regressions: a plain 'sudo
 * whoami' still prompts, and neither 'echo "sudo x" | cat' (quoted word) nor 'echo pw | sudo -S true' (the password is piped) prompts.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { LinuxTerminalSession } from '@/terminal/sessions/LinuxTerminalSession';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';

const key = (k: string) => ({ key: k, ctrlKey: false, altKey: false, metaKey: false, shiftKey: false });
const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 20));

let pc: LinuxPC;
let session: LinuxTerminalSession;

beforeEach(() => {
  EquipmentRegistry.resetInstance();
  pc = new LinuxPC('linux-pc', 'PC-CONSEILLER', 0, 0);
  pc.powerOn();
  session = new LinuxTerminalSession('t', pc);
});

async function enter(line: string): Promise<void> {
  if (session.inputMode.type === 'password') session.setPasswordBuf(line);
  else session.setInput(line);
  session.handleKey(key('Enter'));
  await flush();
}

const texts = (): string[] => session.lines.map((line) => line.text);
const prompt = (): string | undefined => (session.inputMode as { promptText?: string }).promptText;

describe('sudo inside a pipeline or a list', () => {
  it('WITNESS: a plain sudo asks for the password', async () => {
    await enter('sudo whoami');
    expect(session.inputMode.type).toBe('password');
    expect(prompt()).toBe('[sudo] password for user:');
  });

  it.each([
    ["echo '203.0.113.20 monsite.banque' | sudo tee -a /etc/hosts"],
    ['true && sudo whoami'],
    ['false || sudo whoami'],
    ['echo a; sudo whoami'],
  ])('%s asks for the password before running', async (line) => {
    await enter(line);
    expect(session.inputMode.type).toBe('password');
    expect(prompt()).toBe('[sudo] password for user:');
  });

  it('runs the whole line once the password is right and not before', async () => {
    await enter("echo '203.0.113.20 monsite.banque' | sudo tee -a /etc/hosts");
    expect(texts()).not.toContain('203.0.113.20 monsite.banque');
    await enter('admin');
    expect(texts()).toContain('203.0.113.20 monsite.banque');
    await enter('tail -1 /etc/hosts');
    expect(texts().filter((text) => text === '203.0.113.20 monsite.banque').length).toBeGreaterThanOrEqual(2);
  });

  it('a wrong password refuses and the line does not run', async () => {
    await enter("echo '203.0.113.20 monsite.banque' | sudo tee -a /etc/hosts");
    await enter('wrong');
    expect(texts()).toContain('Sorry, try again.');
    expect(texts()).not.toContain('203.0.113.20 monsite.banque');
  });

  it('WITNESS: a quoted word and a piped password do not prompt', async () => {
    await enter('echo "sudo x" | cat');
    expect(session.inputMode.type).toBe('normal');
    expect(texts()).toContain('sudo x');
    await enter('echo admin | sudo -S true');
    expect(session.inputMode.type).toBe('normal');
  });
});
