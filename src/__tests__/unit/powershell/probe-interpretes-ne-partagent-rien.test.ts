/**
 * Deux `new PSInterpreter()` sont deux MACHINES, pas une.
 *
 * Mesure de depart. `NullProviders.ts` construisait ses fournisseurs UNE
 * fois pour tout le module — `filesystem: new SimulatedFileSystem()` et
 * `jobs: new JobProvider()` — et les deux signatures qui les prennent par
 * defaut (`PSInterpreter` et `PSRuntime`) distribuaient donc le meme
 * objet a tout le monde. Deux interpretes sans peripherique partageaient
 * un seul disque :
 *
 *     A: New-Item C:\fuite.txt ; Set-Content ... -Value SECRET
 *     B: Get-Content C:\fuite.txt   ->  SECRET      (attendu : introuvable)
 *     B: Test-Path   C:\fuite.txt   ->  True        (attendu : False)
 *     A: Set-Location C:\dossier
 *     B: (Get-Location).Path        ->  C:\dossier  (attendu : C:\)
 *
 * Le repertoire courant de B suivait donc le `Set-Location` de A. Le
 * defaut existait avant que `$PWD` en derive ; il est devenu observable
 * par une variable de plus.
 *
 * `NULL_PROVIDERS` est desormais une FABRIQUE, `nullProviders()`, appelee
 * a chaque construction.
 *
 * Discrimination par `git stash` : 2 des 4 cas TOMBENT sans le lot — la
 * lecture croisee et le repertoire courant qui suivait.
 *
 * Les 2 qui passent DES DEUX COTES :
 *  - le TEMOIN — un interprete relit son propre fichier. Sans lui, une
 *    fabrique qui rendrait un disque MORT ferait passer les deux cas
 *    d'isolement pour verts en n'ecrivant jamais rien.
 *  - la NON-REGRESSION — un interprete garde son etat d'un appel a
 *    l'autre. C'est ce que la fabrique ne doit PAS casser : un disque
 *    neuf par interprete, pas un disque neuf par commande.
 *
 * Ce cas ecrit en chemin ABSOLU a dessein. Un chemin relatif ne suit pas
 * le repertoire courant dans ce systeme de fichiers-la — `Set-Location`
 * deplace `$PWD` mais `Set-Content .\note.txt` et `Get-ChildItem`
 * travaillent encore a la racine. Le defaut est ANTERIEUR a ce lot,
 * mesure a l'identique avec et sans lui ; il n'est pas ferme ici.
 */

import { describe, it, expect } from 'vitest';
import { PSInterpreter } from '@/powershell/interpreter/PSInterpreter';

describe('deux interpretes sans peripherique ne partagent rien', () => {
  it('TEMOIN : un interprete relit ce qu il vient d ecrire', async () => {
    const a = new PSInterpreter();
    await a.execute('Set-Content -Path C:\\sien.txt -Value MIEN');
    expect((await a.execute('Get-Content C:\\sien.txt')).trim()).toBe('MIEN');
    expect((await a.execute('Test-Path C:\\sien.txt')).trim()).toBe('True');
  });

  it('ce que A ecrit, B ne le voit pas', async () => {
    const a = new PSInterpreter();
    const b = new PSInterpreter();
    await a.execute('Set-Content -Path C:\\fuite.txt -Value SECRET');
    expect((await b.execute('Test-Path C:\\fuite.txt')).trim()).toBe('False');
    expect(await b.execute('Get-Content C:\\fuite.txt')).not.toContain('SECRET');
  });

  it('le Set-Location de A ne deplace pas le repertoire courant de B', async () => {
    const a = new PSInterpreter();
    const b = new PSInterpreter();
    await a.execute('New-Item -Path C:\\dossier -ItemType Directory -Force');
    await a.execute('Set-Location C:\\dossier');
    expect((await a.execute('(Get-Location).Path')).trim()).toBe('C:\\dossier');
    expect((await b.execute('(Get-Location).Path')).trim()).toBe('C:\\');
  });

  it('NON-REGRESSION : un interprete garde SON etat d un appel a l autre', async () => {
    const a = new PSInterpreter();
    await a.execute('New-Item -Path C:\\garde -ItemType Directory -Force');
    await a.execute('Set-Location C:\\garde');
    expect((await a.execute('(Get-Location).Path')).trim()).toBe('C:\\garde');
    await a.execute('Set-Content -Path C:\\garde\\note.txt -Value ICI');
    expect((await a.execute('Get-Content C:\\garde\\note.txt')).trim()).toBe('ICI');
  });
});
