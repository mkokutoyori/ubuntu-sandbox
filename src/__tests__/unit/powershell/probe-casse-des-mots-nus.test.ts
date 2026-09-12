/**
 * Sonde — un mot nu garde sa casse, meme s'il s'ecrit comme un mot-cle.
 *
 * L'analyseur lexical abaisse en minuscules tout mot qui figure dans
 * `PS_KEYWORDS`, pour que l'analyseur syntaxique puisse comparer sans se
 * soucier de la casse. Mais un mot-cle n'est un mot-cle qu'en position
 * d'instruction : `Data`, `Default`, `Process`, `End` ou `Class` employes
 * comme ARGUMENT sont des chaines ordinaires, et PowerShell leur garde
 * leur casse.
 *
 * Ce depot les abaissait : `New-SmbShare -Name Data` creait un partage
 * nomme `data`, et `Write-Output Data` ecrivait `data`. Un nom que
 * l'operateur a tape avec une majuscule lui revenait en minuscules.
 *
 * MESURE PREALABLE, et correction d'une affirmation que j'avais faite
 * trop large : ce n'est PAS tout argument nu qui perdait sa casse.
 * `Write-Output Photos` rendait deja `Photos`. Seuls les mots qui
 * entrent en collision avec un mot-cle etaient touches — trente-quatre
 * mots, dont plusieurs sont des noms de partage ou de compte tout a fait
 * courants.
 *
 * Les attentes sont ecrites d'apres PowerShell, pas d'apres ce que rend
 * ce simulateur.
 */
import { describe, it, expect } from 'vitest';
import { PSInterpreter } from '@/powershell/interpreter/PSInterpreter';

const run = (code: string): string => new PSInterpreter().execute(code);

describe('Sonde — la casse d un mot nu survit a la collision avec un mot-cle', () => {
  it('garde la casse d un argument qui s ecrit comme un mot-cle', () => {
    expect(run('Write-Output Data').trim()).toBe('Data');
    expect(run('Write-Output Default').trim()).toBe('Default');
    expect(run('Write-Output Process').trim()).toBe('Process');
    expect(run('Write-Output Class').trim()).toBe('Class');
  });

  it('garde la casse au milieu d une liste d arguments', () => {
    expect(run('Write-Output Begin End').trim().split(/\s+/)).toEqual(['Begin', 'End']);
  });

  it('garde la casse dans la valeur d un parametre nomme', () => {
    expect(run('Write-Output -InputObject Data').trim()).toBe('Data');
  });

  it('TEMOIN : un mot nu ordinaire gardait deja sa casse', () => {
    expect(run('Write-Output Photos').trim()).toBe('Photos');
  });

  it('TEMOIN : un mot-cle reste un mot-cle en position d instruction', () => {
    expect(run('if ($true) { Write-Output oui } else { Write-Output non }').trim()).toBe('oui');
    expect(run('$t = 0; foreach ($n in 1,2,3) { $t += $n }; Write-Output $t').trim()).toBe('6');
  });

  it('TEMOIN : un mot-cle ecrit en majuscules reste un mot-cle', () => {
    expect(run('IF ($true) { Write-Output vrai }').trim()).toBe('vrai');
    expect(run('$s = 0; FOREACH ($n in 1,2) { $s += $n }; Write-Output $s').trim()).toBe('3');
  });
});
