/**
 * `openssl req` sans -subj dialogue : les sept champs du nom (valeurs par défaut
 * [AU] et [Some-State], « . » vide le champ, vide prend le défaut), les deux
 * attributs d'une demande, la phrase de passe de la clé et sa confirmation.
 * L'oracle est openssl 3.x réel, interrogé par son entrée standard : les invites
 * du simulateur doivent être, mot pour mot, celles qu'il écrit.
 *
 * MESURÉ avant correctif : `req` sans -subj répondait « interactive mode is not
 * implemented in this simulator » ; aucun plan d'interaction n'existait pour
 * openssl. Avant correctif, 6 des 7 cas tombent ; le témoin (avec -subj, aucun
 * dialogue) passe dans les deux états.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import { LinuxTerminalSession } from '@/terminal/sessions/LinuxTerminalSession';
import type { KeyEvent } from '@/terminal/sessions/TerminalSession';
import type { CommandInteractionPlan, InteractionRuntime } from '@/shell/interaction/CommandInteraction';

beforeEach(() => { EquipmentRegistry.getInstance().clear(); });

interface Played { readonly prompts: string[]; readonly output: string[]; readonly executed: string[]; readonly aborted: string | null }

async function play(srv: LinuxServer, line: string, answers: readonly string[]): Promise<Played | null> {
  const plan = (srv as unknown as { interactionPlanFor(l: string, c: object): CommandInteractionPlan | null })
    .interactionPlanFor(line, { currentUser: 'root', currentUid: 0 });
  if (plan === null) return null;
  const played: Played = { prompts: [], output: [], executed: [], aborted: null };
  const values = new Map<string, string>();
  const rt: InteractionRuntime = {
    exec: async (command) => { (played.executed as string[]).push(command); return srv.executeCommand(command); },
    output: (text) => { played.output.push(text); },
    clearScreen: () => {},
    values, metadata: new Map(),
  };
  const queue = [...answers];
  for (const step of plan.steps) {
    if (step.kind === 'output') played.output.push(...step.lines);
    else if (step.kind === 'text' || step.kind === 'password') {
      played.prompts.push(step.prompt);
      let verdict = { valid: false } as { valid: boolean; errorMessage?: string; maxRetries?: number };
      for (let attempt = 0; !verdict.valid; attempt++) {
        const answer = queue.shift() ?? '';
        verdict = step.validate ? step.validate(answer, values) : { valid: true };
        if (verdict.valid) { if (step.storeAs) values.set(step.storeAs, answer); break; }
        played.output.push(verdict.errorMessage ?? '');
        if (verdict.maxRetries !== undefined && attempt >= verdict.maxRetries) return { ...played, aborted: verdict.errorMessage ?? '' };
      }
    } else if (step.kind === 'run') await step.run(rt);
  }
  return played;
}

function realPrompts(args: string[], stdin: string): string[] {
  const run = spawnSync('openssl', args, { input: stdin, encoding: 'utf8' });
  const out = run.stdout + run.stderr;
  return out.match(/[A-Za-z0-9 .,'()-]+ \[[^\]]*\]:|A challenge password \[\]:|An optional company name \[\]:/g) ?? [];
}

const NEW = 'openssl req -new -newkey rsa:1024 -nodes -keyout /tmp/k.pem -out /tmp/c.csr';
const X509 = 'openssl req -x509 -newkey rsa:1024 -nodes -keyout /tmp/k.pem -out /tmp/c.crt';

describe('openssl req interactif', () => {
  it('témoin : avec -subj aucun dialogue', async () => {
    const srv = new LinuxServer('linux-server', 'S'); srv.powerOn();
    expect(await play(srv, `${NEW} -subj /CN=x`, [])).toBeNull();
  });

  it('demande de certificat : mêmes invites que openssl réel, attributs supplémentaires compris', async () => {
    const srv = new LinuxServer('linux-server', 'S'); srv.powerOn();
    const played = await play(srv, NEW, []);
    const real = realPrompts(['req', '-new', '-newkey', 'rsa:1024', '-nodes', '-keyout', '/dev/null'], '\n'.repeat(12));
    expect(played?.prompts.map((p) => p.replace(/:$/, ':'))).toEqual(real);
    expect(real).toHaveLength(9);
  });

  it('certificat auto-signé : sept invites, pas d\'attributs de demande', async () => {
    const srv = new LinuxServer('linux-server', 'S'); srv.powerOn();
    const played = await play(srv, X509, []);
    const real = realPrompts(['req', '-x509', '-newkey', 'rsa:1024', '-nodes', '-keyout', '/dev/null'], '\n'.repeat(12));
    expect(played?.prompts).toEqual(real);
    expect(real).toHaveLength(7);
  });

  it('défauts et « . » : le sujet construit est celui d\'openssl réel', async () => {
    const srv = new LinuxServer('linux-server', 'S'); srv.powerOn();
    await play(srv, X509, ['FR', '', 'Paris', 'Lab', '.', 'www.lab', '']);
    expect(await srv.executeCommand('openssl x509 -in /tmp/c.crt -noout -subject'))
      .toContain('subject=C = FR, ST = Some-State, L = Paris, O = Lab, CN = www.lab');
  });

  it('pays : deux lettres exactement, message d\'openssl', async () => {
    const srv = new LinuxServer('linux-server', 'S'); srv.powerOn();
    const played = await play(srv, X509, ['FRA', 'FR', '', '', '', '', '', '']);
    expect(played?.output).toContain('string is too long, it needs to be no more than 2 bytes long');
  });

  it('clé sans -nodes : phrase de passe demandée deux fois, trop courte refusée, clé chiffrée', async () => {
    const srv = new LinuxServer('linux-server', 'S'); srv.powerOn();
    const line = 'openssl req -x509 -newkey rsa:1024 -keyout /tmp/k.pem -out /tmp/c.crt';
    const played = await play(srv, line, ['abc', 'secret1', 'secret1', 'FR', '', '', '', '', 'x.lab', '']);
    expect(played?.prompts.slice(0, 3)).toEqual(['Enter PEM pass phrase:', 'Verifying - Enter PEM pass phrase:', 'Country Name (2 letter code) [AU]:']);
    expect(played?.output).toContain('phrase is too short, needs to be at least 4 chars');
    expect(await srv.executeCommand('cat /tmp/k.pem')).toContain('BEGIN ENCRYPTED PRIVATE KEY');
  });

  it('confirmation différente : « Verify failure » et abandon', async () => {
    const srv = new LinuxServer('linux-server', 'S'); srv.powerOn();
    const played = await play(srv, 'openssl req -x509 -newkey rsa:1024 -keyout /tmp/k.pem -out /tmp/c.crt', ['secret1', 'secret2']);
    expect(played?.aborted).toContain('Verify failure');
  });

  it('dans un vrai terminal : les invites arrivent une à une et le fichier est écrit', async () => {
    const srv = new LinuxServer('linux-server', 'S');
    const session = new LinuxTerminalSession('t1', srv);
    const key = (k: string): KeyEvent => ({ key: k, ctrlKey: false, altKey: false, metaKey: false, shiftKey: false });
    const flush = async (): Promise<void> => { for (let i = 0; i < 8; i++) { await Promise.resolve(); await new Promise<void>((r) => setTimeout(r, 0)); } };
    const submit = async (text: string): Promise<void> => { if (session.currentInputMode.type === 'interactive-text') session.setInputBuf(text); else session.setInput(text); session.handleKey(key('Enter')); await flush(); };
    await submit(X509);
    expect(session.currentInputMode.type).toBe('interactive-text');
    for (const answer of ['FR', '', 'Paris', 'Lab', '', 'term.lab', '']) await submit(answer);
    expect(session.currentInputMode.type).toBe('normal');
    expect(await srv.executeCommand('openssl x509 -in /tmp/c.crt -noout -subject')).toContain('CN = term.lab');
  });
});
