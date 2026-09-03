/**
 * Le compte par defaut d'un Windows Server est Administrator, et les SIX
 * chemins qui nomment l'utilisateur courant s'accordent.
 *
 * Mesure de depart, sur un `WindowsServer` neuf, au meme instant :
 *   cmd whoami          -> "srv1\Administrator"
 *   cmd echo %USERNAME% -> "User"
 *   cmd echo %USERDOMAIN% -> "%USERDOMAIN%"   (la variable n'existait pas)
 *   ps  whoami          -> "srv1\user"
 *   ps  $env:USERNAME   -> "User"
 *   ps  $env:USERDOMAIN -> "WORKGROUP"
 *
 * Cause : TROIS tables d'environnement decrivaient une meme machine
 * (`WindowsPC.initEnv`, `PowerShellExecutor.resolveEnvVar`,
 * `WindowsPSProviders.wellKnown`). Il n'en reste qu'une, CALCULEE a la
 * lecture depuis l'utilisateur courant, le nom de machine et
 * l'appartenance au domaine ; `this.env` ne garde plus que ce qu'un
 * operateur a pose lui-meme.
 *
 * Discrimine par `git stash` : 9 cas sur 12 tombent avant correctif.
 * Les 3 autres sont nommes plutot que laisses a decouvrir :
 *   - le TEMOIN client (`WindowsPC` garde `User`), dont c'est l'objet de
 *     passer des deux cotes — sans lui, un correctif qui basculerait TOUTE
 *     machine Windows sur Administrator serait indiscernable du bon ;
 *   - `$env:USERDNSDOMAIN` vide hors domaine, qui passait parce que la
 *     variable n'existait nulle part — il garde qu'elle n'apparaisse pas
 *     sur une machine qui n'est pas dans un domaine ;
 *   - `set FOO=bar`, non-regression de la surcharge operateur.
 *
 * `cmd whoami`, lui, TOMBE, et pour une raison qui a demande une source
 * plutot qu'un avis : les DEUX branches de `cmdWhoami` batissaient le
 * meme nom de compte, l'une en abaissant la casse et l'autre non, et le
 * cmdlet PowerShell en abaissait une troisieme fois. La documentation
 * officielle de la commande (MicrosoftDocs/windowsserverdocs,
 * `windows-commands/whoami.md`) donne « DOMAIN1\administrator » : la
 * commande ne transforme AUCUNE casse, elle rend le domaine et le compte
 * tels qu'ils sont enregistres. Les trois ecritures n'en font plus
 * qu'une, et elle ne transforme rien. Deux cas du depot pinnaient cette
 * casse et se contredisaient entre eux (`lab\alice` d'un cote,
 * `srv1\Administrator` de l'autre) — ils sont corriges, pas le code.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { globSync } from 'node:fs';
import { WindowsServer } from '@/network/devices/WindowsServer';
import { WindowsPC } from '@/network/devices/WindowsPC';
import { PowerShellSubShell } from '@/terminal/subshells/PowerShellSubShell';

function pwsh(dev: WindowsPC) {
  const ps = PowerShellSubShell.create(dev as never).subShell;
  return async (line: string) => (await ps.processLine(line)).output.join('\n').trim();
}

async function cmd(dev: WindowsPC, line: string): Promise<string> {
  return String(await dev.executeCommand(line)).trim();
}

function serveur(name = 'SRV1'): WindowsServer {
  const s = new WindowsServer(name);
  s.powerOn();
  return s;
}

const MDP = '-SafeModeAdministratorPassword (ConvertTo-SecureString "P@ssw0rd!" -AsPlainText -Force)';

describe('le compte par defaut d\'un Windows Server', () => {
  it('cmd whoami nomme Administrator', async () => {
    expect(await cmd(serveur(), 'whoami')).toBe('SRV1\\Administrator');
  });

  it('%USERNAME% nomme Administrator', async () => {
    expect(await cmd(serveur(), 'echo %USERNAME%')).toBe('Administrator');
  });

  it('%USERPROFILE% suit le compte', async () => {
    expect(await cmd(serveur(), 'echo %USERPROFILE%')).toBe('C:\\Users\\Administrator');
  });

  it('PowerShell whoami nomme Administrator', async () => {
    expect(await pwsh(serveur())('whoami')).toBe('SRV1\\Administrator');
  });

  it('$env:USERNAME nomme Administrator', async () => {
    expect(await pwsh(serveur())('$env:USERNAME')).toBe('Administrator');
  });

  it('les deux whoami et les deux $USERNAME disent la meme chose', async () => {
    const srv = serveur();
    const ps = pwsh(srv);
    expect(await cmd(srv, 'whoami')).toBe(await ps('whoami'));
    expect(await cmd(srv, 'echo %USERNAME%')).toBe(await ps('$env:USERNAME'));
  });

  it('TEMOIN — un poste client garde le compte User', async () => {
    const pc = new WindowsPC('windows-pc', 'PC1');
    pc.powerOn();
    expect(await cmd(pc, 'echo %USERNAME%')).toBe('User');
    expect(await pwsh(pc)('whoami')).toBe('PC1\\User');
  });
});

describe('USERDOMAIN nomme le domaine du COMPTE', () => {
  it('%USERDOMAIN% existe et vaut le nom de machine hors domaine', async () => {
    expect(await cmd(serveur(), 'echo %USERDOMAIN%')).toBe('SRV1');
  });

  it('$env:USERDOMAIN vaut le nom de machine hors domaine', async () => {
    expect(await pwsh(serveur())('$env:USERDOMAIN')).toBe('SRV1');
  });

  it('$env:USERDNSDOMAIN n\'existe pas hors domaine', async () => {
    expect(await pwsh(serveur())('$env:USERDNSDOMAIN')).toBe('');
  });

  it('une fois promu controleur de domaine, USERDOMAIN est le domaine', async () => {
    const dc = serveur('DC01');
    const ps = pwsh(dc);
    await ps('Install-WindowsFeature -Name AD-Domain-Services');
    await ps(`Install-ADDSForest -DomainName "corp.local" -Force ${MDP}`);
    expect(await ps('$env:USERDOMAIN')).toBe('CORP');
    expect(await ps('$env:USERDNSDOMAIN')).toBe('CORP.LOCAL');
    expect(await cmd(dc, 'echo %USERDOMAIN%')).toBe('CORP');
    expect(await ps('whoami')).toBe('CORP\\Administrator');
    expect(await cmd(dc, 'whoami')).toBe('CORP\\Administrator');
  });

  it('non-regression — une variable posee par l\'operateur l\'emporte', async () => {
    const srv = serveur();
    await cmd(srv, 'set FOO=bar');
    expect(await cmd(srv, 'echo %FOO%')).toBe('bar');
  });
});

describe('il n\'y a qu\'UNE table d\'environnement', () => {
  const VARIABLES = [
    'ALLUSERSPROFILE', 'APPDATA', 'COMPUTERNAME', 'COMSPEC', 'HOMEDRIVE', 'HOMEPATH',
    'LOCALAPPDATA', 'LOGONSERVER', 'NUMBER_OF_PROCESSORS', 'PATHEXT', 'PROCESSOR_ARCHITECTURE',
    'PROGRAMDATA', 'PROGRAMFILES', 'PSMODULEPATH', 'SESSIONNAME', 'SYSTEMDRIVE', 'SYSTEMROOT',
    'USERDOMAIN', 'USERNAME', 'USERPROFILE', 'WINDIR',
  ];
  const DECLARATION = 'src/network/devices/WindowsPC.ts';

  function declare(texte: string, variable: string): boolean {
    for (const guillemet of ["'", '"']) {
      const aiguille = `${guillemet}${variable}${guillemet}`;
      let i = texte.indexOf(aiguille);
      while (i !== -1) {
        if (texte[i + aiguille.length] === ',' || texte[i + aiguille.length] === ':') return true;
        i = texte.indexOf(aiguille, i + 1);
      }
    }
    return false;
  }

  it('un seul fichier declare les variables bien connues de Windows', () => {
    const fichiers = globSync('src/{network,powershell,terminal}/**/*.ts')
      .filter(f => !f.includes('__tests__'));
    expect(fichiers.length).toBeGreaterThan(100);
    const tables: Array<{ fichier: string; compte: number }> = [];
    for (const fichier of fichiers) {
      const texte = readFileSync(fichier, 'utf-8');
      const compte = VARIABLES.filter(v => declare(texte, v)).length;
      if (compte >= 3) tables.push({ fichier, compte });
    }
    expect(tables.map(t => `${t.fichier} (${t.compte})`)).toEqual([`${DECLARATION} (${VARIABLES.length})`]);
  });

  it('les deux enumerations rendent la meme liste', async () => {
    const srv = serveur();
    const noms = (t: string) => t.split('\n').map(l => l.trim().split(/[\s=]/)[0])
      .filter(n => /^[A-Za-z_(][\w()]*$/.test(n) && n !== 'Name' && !n.startsWith('---')).sort();
    const parPowerShell = noms(await pwsh(srv)('Get-ChildItem Env:'));
    const parCmd = noms(await cmd(srv, 'set'));
    expect(parPowerShell.length).toBeGreaterThan(20);
    expect(parPowerShell).toEqual(parCmd);
  });

  it('une variable posee par l\'operateur parait dans les deux', async () => {
    const srv = serveur();
    await cmd(srv, 'set FOO=bar');
    expect(await pwsh(srv)('Get-ChildItem Env:')).toContain('FOO');
    expect(await cmd(srv, 'set FOO')).toContain('bar');
  });
});
