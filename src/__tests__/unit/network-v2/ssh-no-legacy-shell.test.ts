/*
 * Le terminal ne porte plus de moteur de sessions enfants en memoire.
 *
 * Un `ssh` ouvre une connexion reelle : le terminal pilote un sous-shell
 * sur son canal, jamais la session d'un autre equipement attachee comme
 * enfant (`attachAsChildOf`, `foreground`, `adoptRemoteChild`,
 * `prepareAsRemoteUser`) ni l'objet du pair substitue a `device`
 * (`pushRemoteDevice`). Ces membres n'avaient plus aucun appelant de
 * production ; leur presence laissait supposer un chemin sans trame.
 *
 * Discriminee par `git stash push -- src/terminal` : les 4 cas
 * « n'expose plus » (pushRemoteDevice, attachAsChildOf, foreground,
 * prepareAsRemoteUser) tombent avant ; les 4 premiers cas existaient deja
 * et passent des deux cotes (TEMOINS de non-regression).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

function read(rel: string): string {
  return readFileSync(join(process.cwd(), rel), 'utf8');
}

describe('Terminal layer no longer drives SSH through the legacy IShell shells', () => {
  it('LinuxTerminalSession does not reference CrossVendorRemoteShell', () => {
    const src = read('src/terminal/sessions/LinuxTerminalSession.ts');
    expect(src.includes('CrossVendorRemoteShell')).toBe(false);
  });

  it('WindowsTerminalSession does not reference CrossVendorRemoteShell', () => {
    const src = read('src/terminal/sessions/WindowsTerminalSession.ts');
    expect(src.includes('CrossVendorRemoteShell')).toBe(false);
  });

  it('WindowsTerminalSession does not push RemoteDeviceSubShell on ssh', () => {
    const src = read('src/terminal/sessions/WindowsTerminalSession.ts');
    expect(/new\s+RemoteDeviceSubShell\s*\(/.test(src)).toBe(false);
  });

  it('LinuxTerminalSession no longer exposes pushRemoteDeviceWithStrategy', () => {
    const src = read('src/terminal/sessions/LinuxTerminalSession.ts');
    expect(src.includes('pushRemoteDeviceWithStrategy')).toBe(false);
  });

  it('LinuxTerminalSession n\'expose plus pushRemoteDevice ni sa pile', () => {
    const src = read('src/terminal/sessions/LinuxTerminalSession.ts');
    expect(/pushRemoteDevice|popRemoteDevice|sshStack|pushSshChain/.test(src)).toBe(false);
  });

  it('TerminalSession n\'expose plus attachAsChildOf ni la session enfant', () => {
    const src = read('src/terminal/sessions/TerminalSession.ts');
    expect(/attachAsChildOf|detachFromHost|_children|_parent\b/.test(src)).toBe(false);
  });

  it('TerminalSession n\'expose plus foreground', () => {
    const src = read('src/terminal/sessions/TerminalSession.ts');
    expect(/get foreground\(\)|hasActiveChild|isRemoteChild/.test(src)).toBe(false);
  });

  it('aucune session fournisseur ne prepare plus un utilisateur distant en memoire', () => {
    for (const name of ['Linux', 'Windows', 'Cisco', 'Huawei', 'Forti', 'Asa']) {
      expect(read(`src/terminal/sessions/${name}TerminalSession.ts`).includes('prepareAsRemoteUser')).toBe(false);
    }
  });
});
