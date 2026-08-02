/**
 * Probes — les vues de `schtasks`, ses refus, et le journal du
 * planificateur.
 *
 * `docs/PRD-Taches-Planifiees.md` phase 3.
 *
 * Ce qui était mesuré : `/fo LIST`, `/v` et `/xml` étaient acceptés puis
 * ignorés — toujours le même tableau à trois colonnes, alors que le
 * format verbeux est justement ce qu'on regarde en diagnostic ;
 * `/create` réussissait sans `/tr`, créant une tâche sans action, et
 * réécrivait une tâche existante en silence ; `/query /tn <absente>`
 * rendait un tableau vide au lieu de l'erreur que `/delete` produisait
 * déjà ; `weekly` et `monthly` n'avaient pas d'heure ; et il n'y avait
 * aucun journal `Microsoft-Windows-TaskScheduler/Operational`, c'est-à-
 * dire aucun endroit où lire l'historique d'une tâche.
 *
 * Réserve d'honnêteté, la même que pour la phase 1 : il n'y a pas de
 * Windows sur la machine de mesure. Les libellés, les champs du format
 * verbeux et les identifiants d'événement suivent la documentation
 * Microsoft ; ils n'ont pas pu être relevés sur un vrai binaire. Les
 * comportements, eux, sont vérifiés ici.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { WindowsPC } from '@/network/devices/WindowsPC';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';

beforeEach(() => { EquipmentRegistry.resetInstance(); });

function lab(): WindowsPC {
  const pc = new WindowsPC('windows-pc', 'win1', 0, 0);
  pc.powerOn();
  return pc;
}

const creerT = (pc: WindowsPC) =>
  pc.executeCommand('schtasks /create /tn "T" /tr "C:\\bin\\save.exe" /sc daily /st 03:00');

describe('Scénario 1 — `/create` refuse ce qui n\'a pas de sens', () => {
  it('une tâche sans action est refusée', async () => {
    const pc = lab();
    // Une tâche sans `/tr` n'a rien à exécuter ; le vrai la refuse.
    expect(await pc.executeCommand('schtasks /create /tn "X" /sc daily'))
      .toBe('ERROR: The required parameter "/TR" is missing.');
  });

  it('réécrire une tâche existante demande `/f`', async () => {
    const pc = lab();
    await creerT(pc);
    const refus = await pc.executeCommand('schtasks /create /tn "T" /tr "C:\\autre.exe" /sc daily');
    expect(refus).toContain('already exists');
    // Et la tâche d'avant est intacte : écraser en silence l'aurait
    // fait disparaître sans que personne ne le sache.
    expect(await pc.executeCommand('schtasks /query /tn "T" /fo LIST /v')).toContain('C:\\bin\\save.exe');
  });

  it('`/f` autorise l\'écrasement', async () => {
    const pc = lab();
    await creerT(pc);
    expect(await pc.executeCommand('schtasks /create /tn "T" /tr "C:\\autre.exe" /sc daily /f'))
      .toContain('SUCCESS');
    expect(await pc.executeCommand('schtasks /query /tn "T" /fo LIST /v')).toContain('C:\\autre.exe');
  });

  it('interroger une tâche absente rend l\'erreur, pas un tableau vide', async () => {
    const pc = lab();
    // `/delete` disait déjà cette phrase ; `/query` répondait un tableau
    // sans ligne, qui se lit « il n'y a rien à montrer ».
    expect(await pc.executeCommand('schtasks /query /tn "Absente"'))
      .toBe('ERROR: The system cannot find the file specified.');
  });
});

describe('Scénario 2 — chaque planification a son heure', () => {
  // La ligne du tableau est `nom(40) next(22) statut` : découper au
  // rang 41 laissait le statut collé à la date.
  const nextOf = (out: string, name: string) =>
    out.split('\n').find((l) => l.startsWith(name + ' '))?.slice(41, 63).trim() ?? '';

  it('`/sc weekly /d MON` tombe un lundi', async () => {
    const pc = lab();
    await pc.executeCommand('schtasks /create /tn "W" /tr "C:\\w.exe" /sc weekly /d MON /st 04:00');
    const next = nextOf(await pc.executeCommand('schtasks /query'), 'W');
    expect(next).not.toContain('N/A');
    const [date] = next.split(' ');
    expect(new Date(date).getDay()).toBe(1);
  });

  it('`/sc monthly /d 15` tombe le quinze', async () => {
    const pc = lab();
    await pc.executeCommand('schtasks /create /tn "M" /tr "C:\\m.exe" /sc monthly /d 15 /st 05:00');
    const next = nextOf(await pc.executeCommand('schtasks /query'), 'M');
    expect(next).toMatch(/^\d{2}\/15\/\d{4} 05:00:00$/);
  });

  it('`/sc onstart` n\'a pas d\'heure, et le dit', async () => {
    const pc = lab();
    await pc.executeCommand('schtasks /create /tn "B" /tr "C:\\b.exe" /sc onstart');
    // Son déclencheur est un événement que rien ici ne produit : `N/A`
    // est la vérité, pas une lacune d'affichage.
    expect(nextOf(await pc.executeCommand('schtasks /query'), 'B')).toContain('N/A');
  });
});

describe('Scénario 3 — les trois formats de sortie', () => {
  it('`/fo LIST` donne les cinq champs, pas le tableau', async () => {
    const pc = lab();
    await creerT(pc);
    const out = await pc.executeCommand('schtasks /query /tn "T" /fo LIST');
    for (const k of ['HostName:', 'TaskName:', 'Next Run Time:', 'Status:', 'Logon Mode:']) {
      expect(out).toContain(k);
    }
    expect(out).not.toContain('====');
    // Le format court s'arrête là — `Task To Run` appartient au verbeux.
    expect(out).not.toContain('Task To Run:');
  });

  it('`/v` ajoute ce que la tâche porte vraiment', async () => {
    const pc = lab();
    await creerT(pc);
    const out = await pc.executeCommand('schtasks /query /tn "T" /fo LIST /v');
    expect(out).toContain('Task To Run:');
    expect(out).toContain('C:\\bin\\save.exe');
    expect(out).toContain('Schedule Type:');
    expect(out).toMatch(/Schedule Type: *Daily/);
    expect(out).toMatch(/Start Time: *3:00:00 AM/);
    // 267011 = « la tâche n'a pas encore tourné », le code du vrai.
    expect(out).toMatch(/Last Result: *267011/);
  });

  it('`/fo CSV` rend un en-tête et une ligne entre guillemets', async () => {
    const pc = lab();
    await creerT(pc);
    const lignes = (await pc.executeCommand('schtasks /query /tn "T" /fo CSV')).split('\n');
    expect(lignes[0]).toBe('"HostName","TaskName","Next Run Time","Status","Logon Mode"');
    expect(lignes[1]).toContain('"\\T"');
  });

  it('l\'état désactivé se lit aussi dans le verbeux', async () => {
    const pc = lab();
    await creerT(pc);
    await pc.executeCommand('schtasks /change /tn "T" /disable');
    expect(await pc.executeCommand('schtasks /query /tn "T" /fo LIST /v'))
      .toMatch(/Scheduled Task State: *Disabled/);
  });
});

describe('Scénario 4 — le journal du planificateur', () => {
  // Le nom de canal est entre guillemets : l'analyseur d'arguments
  // PowerShell coupe un mot nu sur `/`, et rendrait « Microsoft-Windows-
  // TaskScheduler ». C'est un défaut de l'analyseur, commun à tous les
  // canaux — `Microsoft-Windows-PowerShell/Operational` a le même — et
  // non du planificateur ; le vrai PowerShell accepte les deux formes.
  const lire = (pc: WindowsPC) => pc.executeCommand(
    "powershell -Command \"Get-WinEvent -LogName 'Microsoft-Windows-TaskScheduler/Operational'\"");

  it('le canal existe sur une machine neuve, et il est vide', async () => {
    const pc = lab();
    expect(await pc.executeCommand('wevtutil gl Microsoft-Windows-TaskScheduler/Operational'))
      .toContain('Microsoft-Windows-TaskScheduler%4Operational.evtx');
    expect(await lire(pc)).toContain('No events were found');
  });

  it('enregistrer une tâche laisse un 106', async () => {
    const pc = lab();
    await creerT(pc);
    const out = await lire(pc);
    expect(out).toContain('106');
    expect(out).toContain('registered Task Scheduler task "\\T"');
  });

  it('une exécution laisse le 200, le 201 et le 102', async () => {
    const pc = lab();
    await creerT(pc);
    await pc.executeCommand('schtasks /run /tn "T"');
    const out = await lire(pc);
    expect(out).toContain('200');
    expect(out).toContain('launched action');
    expect(out).toContain('201');
    expect(out).toContain('with return code 0');
    expect(out).toContain('successfully finished');
  });

  it('supprimer une tâche laisse un 141', async () => {
    const pc = lab();
    await creerT(pc);
    await pc.executeCommand('schtasks /delete /tn "T" /f');
    expect(await lire(pc)).toContain('deleted Task Scheduler task "\\T"');
  });

  it('`wevtutil qe` lit le même journal', async () => {
    const pc = lab();
    await creerT(pc);
    // Les deux surfaces sur un seul magasin : elles ne peuvent pas
    // raconter deux histoires de la même tâche.
    expect(await pc.executeCommand('wevtutil qe Microsoft-Windows-TaskScheduler/Operational'))
      .toContain('Event ID: 106');
  });
});

describe('Scénario 5 — les déclencheurs disent ce qu\'on leur a demandé', () => {
  it('`-Daily` n\'est plus rendu comme ponctuel', async () => {
    const pc = lab();
    const out = await pc.executeCommand('powershell -Command "New-ScheduledTaskTrigger -Daily -At 3am"');
    expect(out).toMatch(/Daily *: True/);
    expect(out).toMatch(/Once *: False/);
    // `3am` était lu par `new Date()`, qui rendait une date de 2001.
    expect(out).toContain('3:00 AM');
  });

  it('`-Weekly` et `-AtStartup` aussi', async () => {
    const pc = lab();
    expect(await pc.executeCommand('powershell -Command "New-ScheduledTaskTrigger -Weekly -At 9am"'))
      .toMatch(/Weekly *: True/);
    const boot = await pc.executeCommand('powershell -Command "New-ScheduledTaskTrigger -AtStartup"');
    expect(boot).toMatch(/AtStartup *: True/);
  });

  it('sans aucun mot-clé, le déclencheur reste ponctuel', async () => {
    const pc = lab();
    expect(await pc.executeCommand('powershell -Command "New-ScheduledTaskTrigger -At 3am"'))
      .toMatch(/Once *: True/);
  });
});

describe('Scénario 6 — les cinq cmdlets qui manquaient', () => {
  it('`Get-ScheduledTaskInfo` rend l\'état d\'exécution', async () => {
    const pc = lab();
    await creerT(pc);
    const out = await pc.executeCommand('powershell -Command "Get-ScheduledTaskInfo -TaskName T"');
    expect(out).toContain('LastTaskResult');
    expect(out).toContain('267011');
    expect(out).toContain('NextRunTime');
  });

  it('`Disable-` et `Enable-ScheduledTask` changent l\'état vu par schtasks', async () => {
    const pc = lab();
    await creerT(pc);
    await pc.executeCommand('powershell -Command "Disable-ScheduledTask -TaskName T"');
    // Un seul magasin : ce que la cmdlet pose, la ligne de commande le lit.
    expect(await pc.executeCommand('schtasks /query /tn "T"')).toContain('Disabled');
    await pc.executeCommand('powershell -Command "Enable-ScheduledTask -TaskName T"');
    expect(await pc.executeCommand('schtasks /query /tn "T"')).toContain('Ready');
  });

  it('`Start-ScheduledTask` lance vraiment le programme', async () => {
    const pc = lab();
    await creerT(pc);
    expect(await pc.executeCommand('tasklist')).not.toContain('save.exe');
    await pc.executeCommand('powershell -Command "Start-ScheduledTask -TaskName T"');
    expect(await pc.executeCommand('tasklist')).toContain('save.exe');
  });

  it('`Set-ScheduledTask` change l\'action', async () => {
    const pc = lab();
    await creerT(pc);
    // Le chemin est entre guillemets : l'analyseur PowerShell coupe un mot
    // nu sur `:`, et `-Execute C:\neuf.exe` rendrait un `Execute` vide.
    // C'est un défaut de l'analyseur, commun à tous les arguments — le nom
    // de canal `Microsoft-Windows-…/Operational` a le même — et non du
    // planificateur ; le vrai PowerShell accepte les deux formes.
    await pc.executeCommand(
      'powershell -Command "$a=New-ScheduledTaskAction -Execute \'C:\\neuf.exe\'; Set-ScheduledTask -TaskName T -Action $a"');
    expect(await pc.executeCommand('schtasks /query /tn "T" /fo LIST /v')).toContain('C:\\neuf.exe');
  });

  it('une variable d\'objet traverse le `;` sans perdre l\'objet', async () => {
    const pc = lab();
    // La composition documentée par Microsoft : on construit l'action et le
    // déclencheur dans des variables, puis on les passe à l'enregistrement.
    await pc.executeCommand(
      'powershell -Command "$t=New-ScheduledTaskTrigger -Daily -At 4am; '
      + '$a=New-ScheduledTaskAction -Execute \'z.exe\'; '
      + 'Register-ScheduledTask -TaskName Z -Action $a -Trigger $t"');
    const vue = await pc.executeCommand('schtasks /query /tn "Z" /fo LIST /v');
    expect(vue).toContain('z.exe');
    expect(vue).toContain('Schedule Type:                        Daily');
    expect(vue).toContain('Start Time:                           4:00:00 AM');
  });

  it('une variable de texte du shim est visible du moteur', async () => {
    const pc = lab();
    const out = await pc.executeCommand('powershell -Command "$h=\'bonjour\'; Write-Output $h"');
    expect(out.trim()).toBe('bonjour');
  });

  it('un nom inconnu est signalé, pas ignoré', async () => {
    const pc = lab();
    const out = await pc.executeCommand('powershell -Command "Get-ScheduledTaskInfo -TaskName Absente"');
    expect(out).toContain('Absente');
  });
});
