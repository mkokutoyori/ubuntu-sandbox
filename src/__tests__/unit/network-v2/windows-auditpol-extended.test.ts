import { describe, it, expect, beforeEach } from 'vitest';
import { WindowsPC } from '@/network/devices/WindowsPC';
import { WindowsServer } from '@/network/devices/WindowsServer';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { CiscoSwitch } from '@/network/devices/CiscoSwitch';
import { Cable } from '@/network/hardware/Cable';
import { EventBus } from '@/events/EventBus';
import { IPAddress, SubnetMask, resetCounters, MACAddress } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { PowerShellSubShell } from '@/terminal/subshells/PowerShellSubShell';

const ps = (d: WindowsServer) => PowerShellSubShell.create(d).subShell;
const run = async (sh: ReturnType<typeof ps>, l: string) => (await sh.processLine(l)).output.join('\n');

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  MACAddress.resetCounter();
  Logger.reset();
});

function admin(): WindowsPC {
  const pc = new WindowsPC('windows-pc', 'PC1', 0, 0);
  pc.setCurrentUser('Administrator');
  return pc;
}

describe('auditpol — P9 Filtering Platform Connection/Packet Drop', () => {
  it('5152 (packet drop) is silent until the subcategory is enabled', async () => {
    const bus = new EventBus();
    const cli = new LinuxPC('CLI');
    const win = new WindowsPC('windows-pc', 'PC', 0, 0);
    const sw = new CiscoSwitch('switch-cisco', 'SW', 4);
    cli.setEventBus(bus); win.setEventBus(bus); sw.setEventBus(bus);
    cli.powerOn(); win.powerOn();
    new Cable('a').connect(cli.getPort('eth0')!, sw.getPort('FastEthernet0/1')!);
    new Cable('b').connect(win.getPort('eth0')!, sw.getPort('FastEthernet0/2')!);
    cli.getPort('eth0')!.configureIP(new IPAddress('10.0.0.1'), new SubnetMask('255.255.255.0'));
    win.getPort('eth0')!.configureIP(new IPAddress('10.0.0.2'), new SubnetMask('255.255.255.0'));
    await win.executeCommand(
      'netsh advfirewall firewall add rule name=Block-22 dir=in action=block protocol=TCP localport=22');

    cli.getTcpStack().connect('10.0.0.2', 22);
    const before = (win.eventLog.getEntriesStructured('Security') ?? []).filter((e) => e.eventId === 5152);
    expect(before.length).toBe(0);

    win.auditPolicy.set('Filtering Platform Packet Drop', { success: true, failure: true });
    cli.getTcpStack().connect('10.0.0.2', 22);
    const after = (win.eventLog.getEntriesStructured('Security') ?? []).filter((e) => e.eventId === 5152);
    expect(after.length).toBeGreaterThan(0);
  });
});

describe('auditpol — P10 options globales LSA', () => {
  it('/get /option:CrashOnAuditFail reflète Disabled par défaut', async () => {
    const pc = admin();
    const out = await pc.executeCmdCommand('auditpol /get /option:CrashOnAuditFail');
    expect(out).toContain('CrashOnAuditFail');
    expect(out).toMatch(/Disabled/);
  });

  it('/set /option:CrashOnAuditFail /value:enable persiste et se relit', async () => {
    const pc = admin();
    const out = await pc.executeCmdCommand('auditpol /set /option:CrashOnAuditFail /value:enable');
    expect(out).toMatch(/successfully executed/i);
    const check = await pc.executeCmdCommand('auditpol /get /option:CrashOnAuditFail');
    expect(check).toMatch(/Enabled/);
  });

  it('un nom d\'option inconnu échoue', async () => {
    const pc = admin();
    const out = await pc.executeCmdCommand('auditpol /get /option:BogusOption');
    expect(out).toBe('The option was not found.');
  });

  describe('CrashOnAuditFail — remplissage du journal Security et blocage', () => {
    it('remplir le journal Security (DoNotOverwrite) avec CrashOnAuditFail activé bloque les commandes non-administratives', async () => {
      const pc = admin();
      await pc.executeCmdCommand('auditpol /set /option:CrashOnAuditFail /value:enable');
      pc.eventLog.limitEventLog('Security', { maximumSizeKB: 1, overflowAction: 'DoNotOverwrite' });
      for (let i = 0; i < 5; i++) pc.eventLog.writeEventLog('Security', 'Test', 4624, 'SuccessAudit', 'filler');

      pc.setCurrentUser('User');
      const out = await pc.executeCmdCommand('whoami');
      expect(out).toMatch(/STOP: C0000244 \{Audit Failed\}/);
    });

    it('un administrateur peut toujours remédier (Clear-EventLog) et débloque la session', async () => {
      const pc = admin();
      await pc.executeCmdCommand('auditpol /set /option:CrashOnAuditFail /value:enable');
      pc.eventLog.limitEventLog('Security', { maximumSizeKB: 1, overflowAction: 'DoNotOverwrite' });
      for (let i = 0; i < 5; i++) pc.eventLog.writeEventLog('Security', 'Test', 4624, 'SuccessAudit', 'filler');

      const adminOut = await pc.executeCmdCommand('whoami');
      expect(adminOut).not.toMatch(/STOP/);

      pc.eventLog.clearEventLog('Security');
      pc.setCurrentUser('User');
      const after = await pc.executeCmdCommand('whoami');
      expect(after).not.toMatch(/STOP/);
    });

    it('avec l\'option désactivée, le même remplissage n\'a aucun effet bloquant', async () => {
      const pc = admin();
      pc.eventLog.limitEventLog('Security', { maximumSizeKB: 1, overflowAction: 'DoNotOverwrite' });
      for (let i = 0; i < 5; i++) pc.eventLog.writeEventLog('Security', 'Test', 4624, 'SuccessAudit', 'filler');

      pc.setCurrentUser('User');
      const out = await pc.executeCmdCommand('whoami');
      expect(out).not.toMatch(/STOP/);
    });
  });
});

describe('auditpol — P11 politique d\'audit par utilisateur', () => {
  it('/set /user: /exclude supprime l\'audit pour ce compte sans affecter les autres', async () => {
    const pc = admin();
    await pc.executeCmdCommand('auditpol /set /subcategory:"Logon" /success:enable /failure:enable');
    const applied = await pc.executeCmdCommand('auditpol /set /user:bob /category:"Logon" /exclude /success:enable /failure:enable');
    expect(applied).toMatch(/successfully executed/i);

    expect(pc.auditPolicy.isEnabled('Logon', 'success', 'bob')).toBe(false);
    expect(pc.auditPolicy.isEnabled('Logon', 'success', 'alice')).toBe(true);
    expect(pc.auditPolicy.isEnabled('Logon', 'success')).toBe(true);
  });

  it('/set /user: /include audite un compte spécifique même si la politique machine est désactivée', async () => {
    const pc = admin();
    await pc.executeCmdCommand('auditpol /set /subcategory:"Registry" /success:disable /failure:disable');
    await pc.executeCmdCommand('auditpol /set /user:bob /category:"Registry" /include /success:enable');

    expect(pc.auditPolicy.isEnabled('Registry', 'success', 'bob')).toBe(true);
    expect(pc.auditPolicy.isEnabled('Registry', 'success', 'alice')).toBe(false);
    expect(pc.auditPolicy.isEnabled('Registry', 'success')).toBe(false);
  });

  it('/list /user énumère les comptes ayant une entrée par-utilisateur', async () => {
    const pc = admin();
    await pc.executeCmdCommand('auditpol /set /user:bob /category:"Logon" /exclude /success:enable');
    const out = await pc.executeCmdCommand('auditpol /list /user');
    expect(out).toContain('bob');
  });

  it('/remove /user: supprime l\'entrée par-utilisateur', async () => {
    const pc = admin();
    await pc.executeCmdCommand('auditpol /set /user:bob /category:"Logon" /exclude /success:enable');
    await pc.executeCmdCommand('auditpol /remove /user:bob');
    expect(pc.auditPolicy.isEnabled('Logon', 'success', 'bob')).toBe(pc.auditPolicy.isEnabled('Logon', 'success'));
  });
});

describe('auditpol — P12 audit global de ressource (/resourceSACL)', () => {
  it('/resourceSACL /set /type:File /success couvre un fichier créé après la commande', async () => {
    const pc = admin();
    const out = await pc.executeCmdCommand('auditpol /resourceSACL /set /type:File /success');
    expect(out).toMatch(/successfully executed/i);
    expect(pc.auditPolicy.isResourceAudited('File', 'success')).toBe(true);
  });

  it('/resourceSACL /view /type:File affiche "No entries found." sans réglage préalable', async () => {
    const pc = admin();
    const out = await pc.executeCmdCommand('auditpol /resourceSACL /view /type:File');
    expect(out).toContain('Resource SACLs for File:');
    expect(out).toContain('No entries found.');
  });

  it('/resourceSACL /remove /type:File retire le réglage', async () => {
    const pc = admin();
    await pc.executeCmdCommand('auditpol /resourceSACL /set /type:File /success');
    const out = await pc.executeCmdCommand('auditpol /resourceSACL /remove /type:File');
    expect(out).toMatch(/successfully executed/i);
    expect(pc.auditPolicy.isResourceAudited('File', 'success')).toBe(false);
  });

  it('/resourceSACL sans élévation échoue pour /set', async () => {
    const pc = new WindowsPC('windows-pc', 'PC1', 0, 0);
    const out = await pc.executeCmdCommand('auditpol /resourceSACL /set /type:File /success');
    expect(out).toBe('Error 0x00000522: A required privilege is not held by the client.');
  });
});

describe('auditpol — P13 descripteur de sécurité de la politique (/sd)', () => {
  it('/get /sd renvoie un SDDL par défaut équivalent à "Administrateurs uniquement"', async () => {
    const pc = admin();
    const out = await pc.executeCmdCommand('auditpol /get /sd');
    expect(out).toContain('BA');
  });

  it('un SDDL personnalisé excluant BA fait échouer le prochain /set, même pour un administrateur', async () => {
    const pc = admin();
    const before = await pc.executeCmdCommand('auditpol /set /subcategory:"Logon" /success:enable');
    expect(before).toMatch(/successfully executed/i);

    await pc.executeCmdCommand('auditpol /set /sd:"O:BAG:SYD:(A;;RCWDWO;;;SY)"');
    const after = await pc.executeCmdCommand('auditpol /set /subcategory:"Logon" /success:enable');
    expect(after).toBe('Error 0x00000005: Access is denied.');
  });
});

describe('auditpol — P14 /get /r et compléments /list', () => {
  it('/get /r produit le même contenu que /backup /file: suivi d\'une lecture', async () => {
    const pc = admin();
    await pc.executeCmdCommand('auditpol /backup /file:C:\\ref.csv');
    const fromFile = await pc.executeCmdCommand('type C:\\ref.csv');
    const fromR = await pc.executeCmdCommand('auditpol /get /r');
    expect(fromR.trim()).toBe(fromFile.trim());
  });

  it('/list /category:* liste les 9 noms de catégories', async () => {
    const pc = admin();
    const out = await pc.executeCmdCommand('auditpol /list /category:*');
    expect(out).toContain('Logon/Logoff');
    expect(out).toContain('Account Management');
    expect(out.split('\n').length).toBe(9);
  });

  it('/list /subcategory:<catégorie> liste seulement les sous-catégories de cette catégorie', async () => {
    const pc = admin();
    const out = await pc.executeCmdCommand('auditpol /list /subcategory:"Logon/Logoff"');
    expect(out).toContain('Logon');
    expect(out).not.toContain('Kerberos Authentication Service');
  });
});

describe('auditpol — P8 intégration GPO', () => {
  async function promotedDc(): Promise<WindowsServer> {
    const dc = new WindowsServer('DC01');
    dc.setCurrentUser('Administrator');
    await run(ps(dc), 'Install-WindowsFeature -Name AD-Domain-Services -IncludeManagementTools -IncludeAllSubFeature -Restart:$false');
    await run(ps(dc), 'Install-ADDSForest -DomainName "mandeng.lan" -DomainNetBiosName "MANDENG" -SafeModeAdministratorPassword (ConvertTo-SecureString "DSRM@Mandeng2025!" -AsPlainText -Force) -Force:$true');
    return dc;
  }

  it('une politique d\'audit avancée poussée par GPO se répercute sur auditpol /get au prochain gpupdate', async () => {
    const dc = await promotedDc();
    const store = dc.getDirectoryStore()!;
    store.setGpoSettings('Default Domain Policy', {
      auditPolicy: { 'Process Creation': { success: true, failure: true } },
    });

    dc.gpupdateForce();
    const out = await dc.executeCmdCommand('auditpol /get /subcategory:"Process Creation"');
    expect(out).toMatch(/Success and Failure/);
  });

  it('GPO gagne sur local : un /set local est réécrasé par le prochain gpupdate', async () => {
    const dc = await promotedDc();
    const store = dc.getDirectoryStore()!;
    store.setGpoSettings('Default Domain Policy', {
      auditPolicy: { 'Registry': { success: true, failure: false } },
    });
    dc.gpupdateForce();

    await dc.executeCmdCommand('auditpol /set /subcategory:"Registry" /success:disable');
    let out = await dc.executeCmdCommand('auditpol /get /subcategory:"Registry"');
    expect(out).toMatch(/No Auditing/);

    dc.gpupdateForce();
    out = await dc.executeCmdCommand('auditpol /get /subcategory:"Registry"');
    expect(out).toMatch(/^(?:(?!No Auditing).)*Success/s);
  });
});
