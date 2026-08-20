import { describe, it, expect, beforeEach } from 'vitest';
import { WindowsPC } from '@/network/devices/WindowsPC';
import { WindowsServer } from '@/network/devices/WindowsServer';
import { resetCounters } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { PowerShellSubShell } from '@/terminal/subshells/PowerShellSubShell';

const ps = (d: WindowsServer) => PowerShellSubShell.create(d).subShell;
const run = async (sh: ReturnType<typeof ps>, l: string) => (await sh.processLine(l)).output.join('\n');

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  Logger.reset();
});

function admin(): WindowsPC {
  const pc = new WindowsPC('windows-pc', 'PC1', 0, 0);
  pc.setCurrentUser('Administrator');
  return pc;
}

describe('auditpol — P1 catalogue réel', () => {
  it('/list /subcategory:* énumère toutes les sous-catégories du catalogue', async () => {
    const pc = admin();
    const out = await pc.executeCmdCommand('auditpol /list /subcategory:*');
    expect(out).toContain('Logon');
    expect(out).toContain('Process Creation');
    expect(out).toContain('Kerberos Authentication Service');
    expect(out.split('\n').length).toBeGreaterThan(50);
  });

  it('/get /category:* regroupe par catégorie avec en-têtes de section', async () => {
    const pc = admin();
    const out = await pc.executeCmdCommand('auditpol /get /category:*');
    expect(out).toContain('Logon/Logoff');
    expect(out).toContain('Account Management');
    expect(out).toContain('DS Access');
    expect(out).toContain('Account Logon');
    const logonIdx = out.indexOf('Logon/Logoff');
    const logonSubIdx = out.indexOf('  Logon');
    expect(logonSubIdx).toBeGreaterThan(logonIdx);
  });
});

describe('auditpol — P2 validation stricte', () => {
  it('/set sur un nom de sous-catégorie inexistant échoue sans modifier l\'état', async () => {
    const pc = admin();
    const out = await pc.executeCmdCommand('auditpol /set /subcategory:"Loggon" /success:enable');
    expect(out).toBe('The category was not found.');
  });

  it('/get sur un nom de sous-catégorie inexistant échoue avec le même message', async () => {
    const pc = admin();
    const out = await pc.executeCmdCommand('auditpol /get /subcategory:"Loggon"');
    expect(out).toBe('The category was not found.');
  });

  it('les 4 clés historiques (registry, file system, logon, logoff) restent utilisables', async () => {
    const pc = admin();
    const out = await pc.executeCmdCommand('auditpol /set /subcategory:"Registry" /success:enable');
    expect(out).toMatch(/successfully executed/i);
    const check = await pc.executeCmdCommand('auditpol /get /subcategory:"Registry"');
    expect(check).toMatch(/Success/);
  });
});

describe('auditpol — P3 gate de privilège', () => {
  it('/set sans élévation échoue avec le message réel et ne modifie pas l\'état', async () => {
    const pc = new WindowsPC('windows-pc', 'PC1', 0, 0);
    const before = await pc.executeCmdCommand('auditpol /get /subcategory:"Registry"');
    const out = await pc.executeCmdCommand('auditpol /set /subcategory:"Registry" /success:enable');
    expect(out).toBe('Error 0x00000522: A required privilege is not held by the client.');
    const after = await pc.executeCmdCommand('auditpol /get /subcategory:"Registry"');
    expect(after).toBe(before);
  });

  it('/set avec élévation réussit', async () => {
    const pc = admin();
    const out = await pc.executeCmdCommand('auditpol /set /subcategory:"Registry" /success:enable');
    expect(out).toMatch(/successfully executed/i);
  });

  it('/get ne requiert pas d\'élévation', async () => {
    const pc = new WindowsPC('windows-pc', 'PC1', 0, 0);
    const out = await pc.executeCmdCommand('auditpol /get /category:*');
    expect(out).toContain('System audit policy');
  });
});

describe('auditpol — P6 ligne de base par défaut', () => {
  it('un WindowsPC frais a Logon en Success and Failure et Logoff en Success', async () => {
    const pc = new WindowsPC('windows-pc', 'PC1', 0, 0);
    const logon = await pc.executeCmdCommand('auditpol /get /subcategory:"Logon"');
    expect(logon).toMatch(/Success and Failure/);
    const logoff = await pc.executeCmdCommand('auditpol /get /subcategory:"Logoff"');
    expect(logoff).toMatch(/Success/);
    expect(logoff).not.toMatch(/Success and Failure/);
  });

  it('un WindowsPC frais a Registry et File System désactivés (No Auditing)', async () => {
    const pc = new WindowsPC('windows-pc', 'PC1', 0, 0);
    const out = await pc.executeCmdCommand('auditpol /get /subcategory:"Registry"');
    expect(out).toMatch(/No Auditing/);
  });

  it('un WindowsServer promu DC ajoute Directory Service Changes et Credential Validation à la ligne de base', async () => {
    const dc = new WindowsServer('DC01');
    const beforePromo = await dc.executeCmdCommand('auditpol /get /subcategory:"Directory Service Changes"');
    expect(beforePromo).toMatch(/No Auditing/);

    dc.setCurrentUser('Administrator');
    await run(ps(dc), 'Install-WindowsFeature -Name AD-Domain-Services -IncludeManagementTools -IncludeAllSubFeature -Restart:$false');
    await run(ps(dc), 'Install-ADDSForest -DomainName "mandeng.lan" -DomainNetBiosName "MANDENG" -SafeModeAdministratorPassword (ConvertTo-SecureString "DSRM@Mandeng2025!" -AsPlainText -Force) -Force:$true');

    const dsChanges = await dc.executeCmdCommand('auditpol /get /subcategory:"Directory Service Changes"');
    expect(dsChanges).toMatch(/Success/);
    const credVal = await dc.executeCmdCommand('auditpol /get /subcategory:"Credential Validation"');
    expect(credVal).toMatch(/Success/);
    const krbAuth = await dc.executeCmdCommand('auditpol /get /subcategory:"Kerberos Authentication Service"');
    expect(krbAuth).toMatch(/Success/);
  });
});

describe('auditpol — P7 backup/restore/clear/list', () => {
  it('/backup puis /clear /y puis /restore restaure exactement l\'état précédent', async () => {
    const pc = admin();
    await pc.executeCmdCommand('auditpol /set /subcategory:"Registry" /success:enable /failure:enable');
    await pc.executeCmdCommand('auditpol /set /subcategory:"File System" /success:enable');
    const before = await pc.executeCmdCommand('auditpol /get /category:*');

    const backupOut = await pc.executeCmdCommand('auditpol /backup /file:C:\\audit-backup.csv');
    expect(backupOut).toMatch(/successfully executed/i);

    const clearOut = await pc.executeCmdCommand('auditpol /clear /y');
    expect(clearOut).toMatch(/successfully executed/i);
    const cleared = await pc.executeCmdCommand('auditpol /get /subcategory:"Registry"');
    expect(cleared).toMatch(/No Auditing/);

    const restoreOut = await pc.executeCmdCommand('auditpol /restore /file:C:\\audit-backup.csv');
    expect(restoreOut).toMatch(/successfully executed/i);
    const after = await pc.executeCmdCommand('auditpol /get /category:*');
    expect(after).toBe(before);
  });

  it('/clear sans /y demande confirmation et ne modifie pas l\'état', async () => {
    const pc = admin();
    await pc.executeCmdCommand('auditpol /set /subcategory:"Registry" /success:enable');
    const out = await pc.executeCmdCommand('auditpol /clear');
    expect(out).toMatch(/Use \/y to confirm/);
    const check = await pc.executeCmdCommand('auditpol /get /subcategory:"Registry"');
    expect(check).toMatch(/Success/);
  });

  it('/restore sans élévation échoue', async () => {
    const pc = new WindowsPC('windows-pc', 'PC1', 0, 0);
    const out = await pc.executeCmdCommand('auditpol /restore /file:C:\\nope.csv');
    expect(out).toBe('Error 0x00000522: A required privilege is not held by the client.');
  });

  it('/backup produit un CSV au format réel avec GUID et valeur numérique', async () => {
    const pc = admin();
    await pc.executeCmdCommand('auditpol /backup /file:C:\\dump.csv');
    const out = await pc.executeCmdCommand('type C:\\dump.csv');
    expect(out).toContain('Machine Name,Policy Target,Subcategory,Subcategory GUID,Inclusion Setting,Exclusion Setting,Setting Value');
    expect(out).toMatch(/Logon,\{0CCE9215-69AE-11D9-BED3-505054503030\}/);
  });
});
