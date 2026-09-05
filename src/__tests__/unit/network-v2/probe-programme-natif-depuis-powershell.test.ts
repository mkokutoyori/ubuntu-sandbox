/**
 * Un programme de cmd tape dans PowerShell est SERVI, et par le seul
 * moteur qui le porte.
 *
 * Mesure de depart. Tant que `PowerShellSubShell` retombait sur
 * l'executeur historique, tout nom que l'interpreteur ne resolvait pas
 * finissait par y etre servi. Le retour-arriere supprime, ces commandes
 * ont cesse de repondre — non parce qu'elles ont disparu, mais parce que
 * personne ne les routait plus : `powershell -File`, `gpupdate /force`,
 * `dsregcmd /status`, `auditpol /set`, `net accounts`. Elles vivent
 * toutes dans le moteur cmd de l'equipement, qui est LEUR seule
 * implantation.
 *
 * La reponse n'est pas de les redeclarer une par une : c'est la
 * resolution de commande de PowerShell qui manquait. Un nom que
 * l'interpreteur ne resout pas est desormais confie au moteur cmd de la
 * machine ; si celui-ci ne le connait pas non plus, c'est le REFUS de
 * PowerShell qui est rendu, pas celui de cmd — le message appartient au
 * shell dans lequel on a tape.
 *
 * Deux details que la mesure a imposes. `runSyncNativeCommand` rend
 * `null` pour « pas de chemin SYNCHRONE ici » (`net accounts`), ce qui
 * n'est pas « cette commande n'existe pas » : les deux se distinguent
 * maintenant. Et la ligne confiee a cmd est celle que l'utilisateur a
 * TAPEE quand la commande en occupe le premier mot, sinon les guillemets
 * d'un argument (`auditpol /set /subcategory:"File System"`) se perdent
 * en chemin.
 *
 * Discrimine par `git stash` : 5 des 9 cas tombent au HEAD precedent —
 * `gpupdate`, les guillemets d'`auditpol`, et les trois cas de
 * `Get-CimInstance`. `net accounts` passait deja : le lot precedent
 * avait ouvert la porte asynchrone pour lui seul, et ce lot la
 * generalise. Le refus de PowerShell sur un nom inconnu passait aussi,
 * pour la raison inverse — rien ne le routait nulle part.
 *
 * TEMOIN : `Get-Date`, une cmdlet vivante, prouve que le laboratoire
 * repond. NON-REGRESSION : `ipconfig`, deja declare comme cmdlet native,
 * ne doit pas changer de chemin.
 */

import { describe, it, expect } from 'vitest';
import { WindowsPC } from '@/network/devices/WindowsPC';
import { PowerShellSubShell } from '@/terminal/subshells/PowerShellSubShell';

function lab() {
  const pc = new WindowsPC('windows-pc', 'WIN', 0, 0);
  pc.powerOn();
  pc.setCurrentUser('Administrator');
  const sub = PowerShellSubShell.create(pc).subShell;
  return { pc, ps: async (line: string) => (await sub.processLine(line)).output.join('\n') };
}

describe('un programme de cmd tape dans PowerShell', () => {
  it('TEMOIN : une cmdlet vivante repond', async () => {
    const { ps } = lab();
    expect(await ps('Get-Date')).not.toBe('');
  });

  it('NON-REGRESSION : ipconfig reste servi par sa cmdlet native', async () => {
    const { ps } = lab();
    expect(await ps('ipconfig')).toContain('Windows IP Configuration');
  });

  it('gpupdate est servi, pas refuse', async () => {
    const { ps } = lab();
    const out = await ps('gpupdate /force');
    expect(out).not.toMatch(/is not recognized/i);
  });

  it('auditpol garde les guillemets de son argument', async () => {
    const { pc, ps } = lab();
    await ps('auditpol /set /subcategory:"File System" /success:enable');
    const out = await pc.executeCmdCommand('auditpol /get /subcategory:"File System"');
    expect(out).toMatch(/Success/);
  });

  it('net accounts, qui n a pas de chemin synchrone, repond quand meme', async () => {
    const { ps } = lab();
    expect(await ps('net accounts')).toContain('Minimum password length');
  });

  it('un nom que personne ne porte recoit le refus de POWERSHELL', async () => {
    const { ps } = lab();
    const out = await ps('Get-Zorglub');
    expect(out).toContain('is not recognized as the name of a cmdlet');
    expect(out).not.toContain('internal or external command');
  });

  it('un CHEMIN absent est refuse par PowerShell, sans passer par cmd', async () => {
    const { ps } = lab();
    const out = await ps('& C:\\NuellePart\\absent.ps1');
    expect(out).toContain('is not recognized as the name of a cmdlet');
    expect(out).not.toContain('The system cannot find the path specified');
  });
});

describe('Get-CimInstance sert ses classes depuis la machine', () => {
  it('Win32_ComputerSystem porte le nom et le groupe de travail reels', async () => {
    const { pc, ps } = lab();
    const out = await ps('(Get-CimInstance Win32_ComputerSystem).Name');
    expect(out.trim()).toBe(pc.getHostname());
    expect((await ps('(Get-CimInstance Win32_ComputerSystem).Domain')).trim()).toBe('WORKGROUP');
  });

  it('Win32_OperatingSystem lit le MEME registre que systeminfo', async () => {
    const { pc, ps } = lab();
    const caption = (await ps('(Get-CimInstance Win32_OperatingSystem).Caption')).trim();
    expect(caption).not.toBe('');
    expect(await pc.executeCmdCommand('systeminfo')).toContain(caption.replace('Microsoft ', ''));
  });

  it('une classe inconnue est REFUSEE en la nommant', async () => {
    const { ps } = lab();
    expect(await ps('Get-CimInstance Win32_Zorglub')).toContain('Invalid class "win32_zorglub"');
  });
});
