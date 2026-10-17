/**
 * `net user` accepte les options que la référence Windows Commands lui donne
 * (/times, /workstations, /passwordchg, /passwordreq, /expires dans ses trois
 * formats, /homedir, /profilepath, /scriptpath, /usercomment, /countrycode) ;
 * chacune a un effet que le moteur évalue, ou elle est refusée dans les mots
 * de Windows. Avant : /times, /workstations, /passwordchg, /passwordreq,
 * /homedir, /profilepath, /scriptpath, /usercomment et /countrycode étaient
 * rangés dans les « arguments positionnels » (donc ignorés, ou pris pour un
 * mot de passe), /expires n'acceptait que MM/DD/YYYY, « Password expires »
 * affichait toujours Never, et un compte désactivé/expiré/verrouillé était le
 * seul refus d'ouverture de session.
 *
 * MESURE DE DEPART : 18 cas sur 26 tombent (git stash du code source ; les
 * deux modules neufs, non suivis, restent en place). Passent des deux côtés :
 * les TEMOINS (le compte créé ouvre une session, /active:no la refuse),
 * /fullname et /comment (non-régression) et les quatre cas qui ne touchent
 * que les analyseurs neufs (formats de /times, refus d'horaires, formats de
 * /expires, dates impossibles) -- structurels, ils prouvent l'analyseur et
 * non le branchement, que portent les autres cas.
 *
 * Autorité : docs Windows Commands « net user » (syntaxe, plafonds : nom 20
 * caractères, commentaire 48, 8 postes, heures par pas d'une heure,
 * « Don't include spaces »). Les libellés d'erreur NET HELPMSG (2202, 2221,
 * 2243, 2246, 3500) sont écrits de mémoire, la page n'étant pas lisible ici.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { WindowsPC } from '@/network/devices/WindowsPC';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import { resetCounters, MACAddress } from '@/network/core/types';
import { Logger } from '@/network/core/Logger';
import { PowerShellSubShell } from '@/terminal/subshells/PowerShellSubShell';
import { parseLogonHours, describeLogonHours, logonHoursAllow } from '@/network/devices/windows/WindowsLogonHours';
import { parseAccountExpiry } from '@/network/devices/windows/WindowsAccountExpiry';

beforeEach(() => {
  EquipmentRegistry.getInstance().clear();
  resetCounters();
  MACAddress.resetCounter();
  Logger.reset();
});

function machine(): WindowsPC {
  const pc = new WindowsPC('windows-pc', 'WSRV');
  pc.setCurrentUser('Administrator');
  return pc;
}

const field = (output: string, label: string): string =>
  output.split('\n').find((line) => line.startsWith(label))?.slice(29).trim() ?? '';

const logon = (pc: WindowsPC, name: string, password: string, type = 2, workstation?: string): boolean =>
  pc.getUserManager().checkPassword(name, password, type, true, true, workstation === undefined ? undefined : { workstation });

describe('création et témoins', () => {
  it('TEMOIN: un compte créé avec /add ouvre une session et /active:no la refuse', async () => {
    const pc = machine();
    await pc.executeCommand('net user erin Passw0rd! /add');
    expect(logon(pc, 'erin', 'Passw0rd!')).toBe(true);
    await pc.executeCommand('net user erin /active:no');
    expect(logon(pc, 'erin', 'Passw0rd!')).toBe(false);
  });

  it('TEMOIN: /fullname et /comment sont rangés et affichés', async () => {
    const pc = machine();
    await pc.executeCommand('net user erin Passw0rd! /add /fullname:"Erin Doe" /comment:"stagiaire"');
    const view = await pc.executeCommand('net user erin');
    expect(field(view, 'Full Name')).toBe('Erin Doe');
    expect(field(view, 'Comment')).toBe('stagiaire');
  });
});

describe('/times : les heures de connexion', () => {
  it('se lit en 12 h et en 24 h, avec jours abrégés ou en toutes lettres', () => {
    for (const spec of ['M-F,8am-5pm', 'M-F,08:00-17:00', 'monday-friday,8AM-5PM', 'M,F,8am-5pm']) {
      const parsed = parseLogonHours(spec);
      expect(parsed.ok, spec).toBe(true);
    }
    const mixed = parseLogonHours('M,4AM-12PM;T,12PM-8PM;W-F,8AM-5PM');
    expect(mixed.ok && mixed.hours !== null && describeLogonHours(mixed.hours)).toEqual([
      'Monday 4:00 AM - Monday 12:00 PM',
      'Tuesday 12:00 PM - Tuesday 8:00 PM',
      'Wednesday 8:00 AM - Wednesday 5:00 PM',
      'Thursday 8:00 AM - Thursday 5:00 PM',
      'Friday 8:00 AM - Friday 5:00 PM',
    ]);
  });

  it('refuse un horaire malformé, un pas qui n\'est pas d\'une heure, un jour inconnu', () => {
    for (const spec of ['M-F,8:30am-5pm', 'Q,8am-5pm', 'M-F,8am-', 'M-F,13pm-5pm', '8am-5pm']) {
      expect(parseLogonHours(spec).ok, spec).toBe(false);
    }
  });

  it('un compte hors de ses heures est refusé à l\'ouverture de session, 0xC000006F au journal', async () => {
    const pc = machine();
    await pc.executeCommand('net user erin Passw0rd! /add');
    const monday9am = Date.UTC(2026, 9, 19, 9, 0, 0);
    const parsed = parseLogonHours('M-F,8am-5pm');
    expect(parsed.ok && logonHoursAllow(parsed.hours ?? undefined, monday9am, 'UTC')).toBe(true);
    expect(parsed.ok && logonHoursAllow(parsed.hours ?? undefined, Date.UTC(2026, 9, 17, 9, 0, 0), 'UTC')).toBe(false);
    expect(await pc.executeCommand('net user erin /times:')).toContain('completed successfully');
    expect(logon(pc, 'erin', 'Passw0rd!')).toBe(false);
    const failed = String(await pc.executeCmdCommand('wevtutil qe Security /q:"*[System[EventID=4625]]" /rd:true /c:1 /f:xml'));
    expect(failed).toContain("<Data Name='Status'>0xC000006F</Data>");
    await pc.executeCommand('net user erin /times:all');
    expect(logon(pc, 'erin', 'Passw0rd!')).toBe(true);
  });

  it('s\'affiche dans « Logon hours allowed » et le préfixe /time: est accepté', async () => {
    const pc = machine();
    await pc.executeCommand('net user miked Passw0rd! /add');
    expect(await pc.executeCommand('net user miked /time:M-F,8AM-5PM')).toContain('completed successfully');
    const view = await pc.executeCommand('net user miked');
    expect(field(view, 'Logon hours allowed')).toBe('Monday 8:00 AM - Monday 5:00 PM');
    expect(view).toContain('Friday 8:00 AM - Friday 5:00 PM');
    await pc.executeCommand('net user miked /times:all');
    expect(field(await pc.executeCommand('net user miked'), 'Logon hours allowed')).toBe('All');
  });

  it('une valeur invalide à la création n\'engendre ni compte ni événement 4720', async () => {
    const pc = machine();
    const out = await pc.executeCommand('net user erin Passw0rd! /add /times:M-F,8:30am-5pm');
    expect(out).toContain('The command syntax is invalid.');
    expect(out).toContain('NET HELPMSG 3500');
    expect(await pc.executeCommand('net user erin')).toContain('could not be found');
    const created = String(await pc.executeCmdCommand('wevtutil qe Security /q:"*[System[EventID=4720]]" /f:xml'));
    expect(created).not.toContain('erin');
  });
});

describe('/workstations', () => {
  it('limite les postes d\'où le compte peut ouvrir une session', async () => {
    const pc = machine();
    await pc.executeCommand('net user erin Passw0rd! /add /workstations:PC1,PC2');
    expect(logon(pc, 'erin', 'Passw0rd!', 3, 'PC1')).toBe(true);
    expect(logon(pc, 'erin', 'Passw0rd!', 3, 'PC9')).toBe(false);
    const failed = String(await pc.executeCmdCommand('wevtutil qe Security /q:"*[System[EventID=4625]]" /rd:true /c:1 /f:xml'));
    expect(failed).toContain("<Data Name='Status'>0xC0000070</Data>");
    expect(field(await pc.executeCommand('net user erin'), 'Workstations allowed')).toBe('PC1,PC2');
  });

  it('sans liste ou avec *, tous les postes sont admis ; au plus huit entrées', async () => {
    const pc = machine();
    await pc.executeCommand('net user erin Passw0rd! /add /workstations:PC1');
    await pc.executeCommand('net user erin /workstations:*');
    expect(logon(pc, 'erin', 'Passw0rd!', 3, 'ANY')).toBe(true);
    expect(field(await pc.executeCommand('net user erin'), 'Workstations allowed')).toBe('All');
    const nine = 'A,B,C,D,E,F,G,H,I';
    expect(await pc.executeCommand(`net user erin /workstations:${nine}`)).toContain('The command syntax is invalid.');
  });

  it('une ouverture locale (type 2 ou 10 sans nom de poste) se compare au nom de la machine', async () => {
    const pc = machine();
    await pc.executeCommand('net user erin Passw0rd! /add /workstations:OTHER');
    expect(logon(pc, 'erin', 'Passw0rd!')).toBe(false);
    await pc.executeCommand('net user erin /workstations:WSRV');
    expect(logon(pc, 'erin', 'Passw0rd!')).toBe(true);
  });
});

describe('/expires : les trois formats de la référence', () => {
  const now = Date.UTC(2018, 0, 10);

  it('MM/DD/YYYY, mmm,dd,YYYY, mois en toutes lettres, année sur deux chiffres', () => {
    const cases: Array<[string, string]> = [
      ['1/9/18', '2018-01-09'],
      ['01/09/2019', '2019-01-09'],
      ['Jan,9,2019', '2019-01-09'],
      ['January,9,2019', '2019-01-09'],
      ['13/01/2019', '2019-01-13'],
    ];
    for (const [text, iso] of cases) {
      expect(parseAccountExpiry(text, now)?.toISOString().slice(0, 10), text).toBe(iso);
    }
  });

  it('sans année, c\'est la prochaine occurrence de la date', () => {
    expect(parseAccountExpiry('Jan,9', now)?.toISOString().slice(0, 10)).toBe('2019-01-09');
    expect(parseAccountExpiry('1/9', now)?.toISOString().slice(0, 10)).toBe('2019-01-09');
    expect(parseAccountExpiry('Jan,12', now)?.toISOString().slice(0, 10)).toBe('2018-01-12');
  });

  it('refuse une date impossible ou malformée ; never remet à zéro', () => {
    for (const text of ['2/30/2020', 'Foo,3,2020', '1/9/2020/5', '1-9-2020', 'tomorrow']) {
      expect(parseAccountExpiry(text, now), text).toBeUndefined();
    }
    expect(parseAccountExpiry('never', now)).toBeNull();
  });

  it('une date passée désactive l\'ouverture de session, affichée avec l\'heure', async () => {
    const pc = machine();
    await pc.executeCommand('net user erin Passw0rd! /add /expires:Jan,9,2001');
    expect(field(await pc.executeCommand('net user erin'), 'Account expires')).toBe('1/9/2001 12:00:00 AM');
    expect(logon(pc, 'erin', 'Passw0rd!')).toBe(false);
    await pc.executeCommand('net user erin /expires:never');
    expect(field(await pc.executeCommand('net user erin'), 'Account expires')).toBe('Never');
    expect(logon(pc, 'erin', 'Passw0rd!')).toBe(true);
  });
});

describe('mot de passe : /passwordchg, /passwordreq et les dates affichées', () => {
  it('/passwordchg:no interdit au titulaire de changer son mot de passe (2243)', async () => {
    const pc = machine();
    await pc.executeCommand('net user erin Passw0rd! /add /passwordchg:no');
    expect(field(await pc.executeCommand('net user erin'), 'User may change password')).toBe('No');
    expect(pc.getUserManager().changePassword('erin', 'Passw0rd!', 'Another1Passw0rd!')).toContain('cannot be changed');
    await pc.executeCommand('net user erin /passwordchg:yes');
    expect(pc.getUserManager().changePassword('erin', 'Passw0rd!', 'Another1Passw0rd!')).toBe('');
  });

  it('/minpwage retarde le changement par le titulaire (2246), pas la réinitialisation par un administrateur', async () => {
    const pc = machine();
    await pc.executeCommand('net accounts /minpwage:2');
    await pc.executeCommand('net user erin Passw0rd! /add');
    expect(pc.getUserManager().changePassword('erin', 'Passw0rd!', 'Another1Passw0rd!')).toContain('too recent');
    expect(await pc.executeCommand('net user erin Another1Passw0rd!')).toContain('completed successfully');
  });

  it('/passwordreq:no admet un mot de passe vide malgré une longueur minimale ; yes le refuse', async () => {
    const pc = machine();
    await pc.executeCommand('net accounts /minpwlen:8');
    await pc.executeCommand('net user erin Passw0rd! /add /passwordreq:no');
    expect(field(await pc.executeCommand('net user erin'), 'Password required')).toBe('No');
    expect(await pc.executeCommand('net user erin ""')).toContain('completed successfully');
    expect(logon(pc, 'erin', '')).toBe(true);
    expect(await pc.executeCommand('net user erin /passwordreq:yes')).toContain('does not meet the password policy');
  });

  it('« Password expires » suit /maxpwage et « Password changeable » suit /minpwage', async () => {
    const pc = machine();
    await pc.executeCommand('net accounts /maxpwage:10');
    await pc.executeCommand('net accounts /minpwage:1');
    await pc.executeCommand('net user erin Passw0rd! /add');
    const view = await pc.executeCommand('net user erin');
    const set = Date.parse(`${field(view, 'Password last set')} UTC`);
    expect(Date.parse(`${field(view, 'Password expires')} UTC`) - set).toBe(10 * 86_400_000);
    expect(Date.parse(`${field(view, 'Password changeable')} UTC`) - set).toBe(86_400_000);
    await pc.executeCommand('net accounts /maxpwage:unlimited');
    expect(field(await pc.executeCommand('net user erin'), 'Password expires')).toBe('Never');
  });

  it('Guest ne porte pas de date d\'expiration de mot de passe', async () => {
    const pc = machine();
    expect(field(await pc.executeCommand('net user Guest'), 'Password expires')).toBe('Never');
  });
});

describe('profil : /homedir, /profilepath, /scriptpath, /usercomment, /countrycode', () => {
  it('sont rangés et affichés aux libellés de Windows', async () => {
    const pc = machine();
    await pc.executeCommand('mkdir C:\\Homes\\erin');
    const out = await pc.executeCommand(
      'net user erin Passw0rd! /add /homedir:C:\\Homes\\erin /profilepath:\\\\srv\\profiles\\erin /scriptpath:logon.bat /usercomment:"Equipe réseau" /countrycode:33');
    expect(out).toContain('completed successfully');
    const view = await pc.executeCommand('net user erin');
    expect(field(view, 'Home directory')).toBe('C:\\Homes\\erin');
    expect(field(view, 'User profile')).toBe('\\\\srv\\profiles\\erin');
    expect(field(view, 'Logon script')).toBe('logon.bat');
    expect(field(view, "User's comment")).toBe('Equipe réseau');
    expect(field(view, 'Country/region code')).toBe('033 (France)');
  });

  it('un répertoire personnel qui n\'existe pas, un script absolu, un code inconnu sont refusés', async () => {
    const pc = machine();
    await pc.executeCommand('net user erin Passw0rd! /add');
    expect(await pc.executeCommand('net user erin /homedir:C:\\Nowhere')).toContain('cannot find the path');
    expect(await pc.executeCommand('net user erin /scriptpath:C:\\logon.bat')).toContain('The command syntax is invalid.');
    expect(await pc.executeCommand('net user erin /countrycode:999')).toContain('The command syntax is invalid.');
  });

  it('les plafonds de la référence : nom 20 caractères, commentaire 48', async () => {
    const pc = machine();
    expect(await pc.executeCommand(`net user ${'x'.repeat(21)} Passw0rd! /add`)).toContain('NET HELPMSG 2202');
    await pc.executeCommand('net user erin Passw0rd! /add');
    expect(await pc.executeCommand(`net user erin /comment:"${'c'.repeat(49)}"`)).toContain('The command syntax is invalid.');
    expect(await pc.executeCommand(`net user erin /usercomment:"${'c'.repeat(48)}"`)).toContain('completed successfully');
  });

  it('une option inconnue ou ambiguë est refusée au lieu d\'être ignorée', async () => {
    const pc = machine();
    await pc.executeCommand('net user erin Passw0rd! /add');
    expect(await pc.executeCommand('net user erin /zorglub:1')).toContain('The command syntax is invalid.');
    expect(await pc.executeCommand('net user erin /co:1')).toContain('The command syntax is invalid.');
    expect(await pc.executeCommand('net user erin /ful:"Erin D"')).toContain('completed successfully');
  });

  it('chaque changement d\'attribut laisse un 4738', async () => {
    const pc = machine();
    await pc.executeCommand('net user erin Passw0rd! /add');
    const before = String(await pc.executeCmdCommand('wevtutil qe Security /q:"*[System[EventID=4738]]" /f:xml')).split('</Event>').length;
    await pc.executeCommand('net user erin /times:all /workstations:* /passwordchg:no');
    const after = String(await pc.executeCmdCommand('wevtutil qe Security /q:"*[System[EventID=4738]]" /f:xml')).split('</Event>').length;
    expect(after - before).toBe(3);
  });
});

describe('PowerShell : la même table de comptes', () => {
  it('Get-LocalUser expose UserMayChangePassword et PasswordExpires, Set-LocalUser les modifie', async () => {
    const pc = machine();
    await pc.executeCommand('net user erin Passw0rd! /add /passwordchg:no');
    const shell = PowerShellSubShell.create(pc).subShell;
    const read = async (property: string) =>
      (await shell.processLine(`(Get-LocalUser erin).${property}`)).output.join('\n').trim();
    expect(await read('UserMayChangePassword')).toBe('False');
    await shell.processLine('Set-LocalUser erin -UserMayChangePassword $true');
    expect(field(await pc.executeCommand('net user erin'), 'User may change password')).toBe('Yes');
    await shell.processLine('Set-LocalUser erin -PasswordNeverExpires $true');
    expect(field(await pc.executeCommand('net user erin'), 'Password expires')).toBe('Never');
    expect(await read('PrincipalSource')).toBe('Local');
  });
});

describe('SSH : les restrictions de compte jouent aussi pour la clé (S4U) et le mot de passe', () => {
  it('une heure interdite ferme la porte même quand la clé est valide', async () => {
    const pc = machine();
    await pc.executeCommand('net user erin Passw0rd! /add /times:');
    expect(pc.getUserManager().logonRefusal('erin')).toBe('logon-hours');
    await pc.executeCommand('net user erin /times:all /workstations:ELSEWHERE');
    expect(pc.getUserManager().logonRefusal('erin')).toBe('workstation');
    await pc.executeCommand('net user erin /workstations:WSRV');
    expect(pc.getUserManager().logonRefusal('erin')).toBeNull();
  });
});
