/**
 * Probes — lancer un script PowerShell, et en sortir.
 *
 * Deux manques que les scénarios de panne ont révélés, tous deux dans
 * le chemin le plus banal qui soit : un script d'exploitation qu'on
 * lance et qui rend un code.
 *
 *   - `powershell -File <script>` : l'option était reconnue puis jetée.
 *     La commande ne rendait rien du tout, et lui ajouter un paramètre
 *     de script faisait retomber la ligne entière sur cmd.exe.
 *   - `exit` : pas un mot-clé. Tout script se terminant par `exit 0`
 *     finissait sur « le terme 'exit' n'est pas reconnu ».
 *
 * En chemin : l'opérateur d'appel `&` ne survivait pas à l'analyse dès
 * que sa cible était citée ou tenue dans une variable, si bien que
 * `& 'C:\x.ps1'` et `& $chemin` affichaient leur propre texte au lieu
 * de lancer quoi que ce soit.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { resetCounters } from '@/network/core/types';
import { WindowsServer } from '@/network/devices/WindowsServer';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { PowerShellSubShell } from '@/terminal/subshells/PowerShellSubShell';

beforeEach(() => { resetCounters(); resetDeviceCounters(); Logger.reset(); });

const SCRIPT = `param([string]$Cible = "rien")
Write-Output "CIBLE=$Cible"
exit 7
Write-Output "APRES_EXIT"`;

async function poste(): Promise<(l: string) => Promise<string>> {
  const dc = new WindowsServer('DC01');
  const sh = PowerShellSubShell.create(dc).subShell;
  const run = async (l: string) => (await sh.processLine(l)).output.join('\n');
  await run('New-Item -Path C:\\Scripts -ItemType Directory -Force');
  await run(`Set-Content -Path C:\\Scripts\\essai.ps1 -Value @'\n${SCRIPT}\n'@`);
  return run;
}

describe('Scénario 1 — les quatre façons de lancer le même script', () => {
  for (const [nom, ligne] of [
    ['l\'opérateur d\'appel, chemin nu', '& C:\\Scripts\\essai.ps1'],
    ['l\'opérateur d\'appel, chemin cité', "& 'C:\\Scripts\\essai.ps1'"],
    ['l\'hôte natif', 'powershell -File C:\\Scripts\\essai.ps1'],
    ['l\'hôte natif avec son suffixe .exe', 'powershell.exe -File C:\\Scripts\\essai.ps1'],
  ] as const) {
    it(nom, async () => {
      const run = await poste();
      const out = await run(ligne);
      expect(out).toContain('CIBLE=rien');
      expect(out).not.toMatch(/is not recognized/i);
    });
  }

  it('l\'opérateur d\'appel sur une variable lance le script, sans l\'afficher', async () => {
    const run = await poste();
    await run("$chemin = 'C:\\Scripts\\essai.ps1'");
    const out = await run('& $chemin');
    expect(out).toContain('CIBLE=rien');
    expect(out).not.toContain('C:\\Scripts\\essai.ps1');
  });

  it('l\'opérateur d\'appel sur un nom de cmdlet cité l\'exécute', async () => {
    const run = await poste();
    const out = await run("& 'Write-Output' bonjour");
    expect(out.trim()).toBe('bonjour');
  });
});

describe('Scénario 2 — les paramètres traversent, dans les deux formes', () => {
  it('l\'opérateur d\'appel passe le paramètre', async () => {
    const run = await poste();
    expect(await run("& 'C:\\Scripts\\essai.ps1' -Cible 10.0.0.1")).toContain('CIBLE=10.0.0.1');
  });

  it('`-File` passe ce qui le suit au script, pas à l\'hôte', async () => {
    const run = await poste();
    expect(await run('powershell -File C:\\Scripts\\essai.ps1 -Cible 192.168.10.10'))
      .toContain('CIBLE=192.168.10.10');
  });

  it('les options de l\'hôte précédant `-File` ne sont pas prises pour le script', async () => {
    const run = await poste();
    expect(await run('powershell -NoProfile -ExecutionPolicy Bypass -File C:\\Scripts\\essai.ps1'))
      .toContain('CIBLE=rien');
  });
});

describe('Scénario 3 — `exit` termine, et laisse un code', () => {
  it('rien de ce qui suit `exit` ne s\'exécute', async () => {
    const run = await poste();
    const out = await run('& C:\\Scripts\\essai.ps1');
    expect(out).toContain('CIBLE=rien');
    expect(out).not.toContain('APRES_EXIT');
  });

  it('$LASTEXITCODE porte le code rendu', async () => {
    const run = await poste();
    await run('& C:\\Scripts\\essai.ps1');
    expect((await run('$LASTEXITCODE')).trim()).toBe('7');
  });

  it('un script qui va au bout laisse un code nul', async () => {
    const run = await poste();
    await run("Set-Content -Path C:\\Scripts\\ok.ps1 -Value 'Write-Output fini'");
    await run('& C:\\Scripts\\ok.ps1');
    expect((await run('$LASTEXITCODE')).trim()).toBe('0');
  });

  it('`exit` n\'est pas rattrapé par un `catch`', async () => {
    const run = await poste();
    await run(`Set-Content -Path C:\\Scripts\\essaye.ps1 -Value @'
try { exit 4 } catch { Write-Output "RATTRAPE" } finally { Write-Output "FINALLY" }
Write-Output "APRES"
'@`);
    const out = await run('& C:\\Scripts\\essaye.ps1');
    expect(out).not.toContain('RATTRAPE');
    expect(out).toContain('FINALLY');
    expect(out).not.toContain('APRES');
    expect((await run('$LASTEXITCODE')).trim()).toBe('4');
  });

  it('`exit` sans code vaut zéro', async () => {
    const run = await poste();
    await run("Set-Content -Path C:\\Scripts\\nu.ps1 -Value 'Write-Output un\nexit'");
    const out = await run('& C:\\Scripts\\nu.ps1');
    expect(out).toContain('un');
    expect((await run('$LASTEXITCODE')).trim()).toBe('0');
  });
});
