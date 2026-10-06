/**
 * Apres `date -s` (Linux) ou `Set-Date` (Windows), toutes les vues d'une machine donnent LA MEME
 * heure : dates des fichiers, journal, syslog, auth.log, `chage -l`, `uptime -s`, `systemctl
 * status`, `dir`. Une machine n'a qu'une horloge (`probe-horloge-de-la-machine`) ; ce probe verifie
 * que ses sous-systemes la lisent.
 *
 * MESURE DE DEPART, apres `sudo date -s "2030-01-01 12:00:00"` sur un LinuxPC :
 *  - `ls -l` d'un fichier cree juste apres : « Oct 6 13:26 » ; le journal, syslog et auth.log :
 *    « Oct  6 13:26:02 » ; `chage -l` d'un compte cree apres : « Oct 06, 2026 » ; `uptime -s` :
 *    l'heure reelle de demarrage — alors que `date` disait 2030 ;
 *  - `Set-Date -Date '2030-01-01 12:00:00'` etait un STUB : accepte, rien ne changeait ;
 *  - `dir` d'un fichier cree apres `Set-Date` : la date reelle, pas celle de l'horloge de la machine.
 * Discriminee contre l'etat d'avant (`git checkout <commit precedent> -- src`) : 8 des 10 cas
 * tombent. Les deux qui passent des deux cotes sont les TEMOINS des labos (« le labo pose son
 * horloge », « le labo repond a Get-Date »). Limites NOMMEES : le `START` de `ps` des processus de
 * demarrage et les dates de `last` / `who` (enregistrements utmp absolus) ne bougent pas avec
 * `date -s` ; sur un vrai noyau `ps` suit (btime), `last` non (entree `TODO.md`).
 */
import { describe, it, expect } from 'vitest';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { WindowsPC } from '@/network/devices/WindowsPC';

const SET = 'sudo date -s "2030-01-01 12:00:00"';

describe('every view of a Linux machine reads the clock that date -s set', () => {
  it('the lab sets its clock — WITNESS', async () => {
    const pc = new LinuxPC('linux-pc', 'PC1');
    await pc.executeCommand(SET);
    expect(await pc.executeCommand('date -u +%Y')).toBe('2030');
  });

  it('a file created afterwards carries the new date', async () => {
    const pc = new LinuxPC('linux-pc', 'PC1');
    await pc.executeCommand(SET);
    await pc.executeCommand('touch /tmp/f');
    expect(await pc.executeCommand('ls -l --time-style=full-iso /tmp/f')).toContain('Jan  1 12:00');
  });

  it('the journal stamps its entries with it', async () => {
    const pc = new LinuxPC('linux-pc', 'PC1');
    await pc.executeCommand(SET);
    await pc.executeCommand('logger hello');
    expect(await pc.executeCommand('sudo journalctl -n 1 --no-pager -o short-iso')).toContain('2030-01-01T12:00');
  });

  it('syslog and auth.log lines carry it', async () => {
    const pc = new LinuxPC('linux-pc', 'PC1');
    await pc.executeCommand(SET);
    await pc.executeCommand('logger hello');
    expect(await pc.executeCommand('sudo tail -n 1 /var/log/syslog')).toContain('Jan  1 12:00');
    expect(await pc.executeCommand('sudo tail -n 1 /var/log/auth.log')).toContain('Jan  1 12:00');
  });

  it('a user created afterwards changed its password on that day', async () => {
    const pc = new LinuxPC('linux-pc', 'PC1');
    await pc.executeCommand(SET);
    await pc.executeCommand('sudo useradd zed');
    expect(await pc.executeCommand('sudo chage -l zed | head -1')).toContain('Jan 01, 2030');
  });

  it('uptime -s is the new now minus the uptime', async () => {
    const pc = new LinuxPC('linux-pc', 'PC1');
    await pc.executeCommand(SET);
    expect(String(await pc.executeCommand('uptime -s'))).toMatch(/^2030-01-01 1[12]:/);
  });
});

describe('every view of a Windows machine reads the clock that Set-Date set', () => {
  const setDate = "powershell -c \"Set-Date -Date '2030-01-01 12:00:00'\"";

  it('the lab answers Get-Date — WITNESS', async () => {
    const pc = new WindowsPC('windows-pc', 'WIN1');
    expect(String(await pc.executeCommand('powershell -c "Get-Date -Format yyyy"')).trim()).toMatch(/^20\d\d$/);
  });

  it('Set-Date moves Get-Date and date /t together', async () => {
    const pc = new WindowsPC('windows-pc', 'WIN1');
    pc.setCurrentUser('Administrator');
    await pc.executeCommand(setDate);
    expect(String(await pc.executeCommand('powershell -c "Get-Date -Format yyyy-MM-dd"')).trim()).toBe('2030-01-01');
    expect(String(await pc.executeCommand('date /t'))).toContain('01/01/2030');
  });

  it('a file written afterwards carries the new date in dir', async () => {
    const pc = new WindowsPC('windows-pc', 'WIN1');
    pc.setCurrentUser('Administrator');
    await pc.executeCommand(setDate);
    await pc.executeCommand('echo hi > C:\\a.txt');
    expect(String(await pc.executeCommand('dir C:\\a.txt'))).toContain('01/01/2030');
  });

  it('a non-administrator does not set the clock', async () => {
    const pc = new WindowsPC('windows-pc', 'WIN1');
    const out = String(await pc.executeCommand(setDate));
    expect(out).toContain('privilege');
    expect(String(await pc.executeCommand('powershell -c "Get-Date -Format yyyy"')).trim()).not.toBe('2030');
  });
});
