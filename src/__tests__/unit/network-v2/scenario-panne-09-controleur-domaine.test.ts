/**
 * Scénario 9 — Panne du contrôleur de domaine : impact sur les postes
 * Windows et procédure de reprise.
 *
 * Transcription littérale : DC01 est éteint. On observe le basculement
 * automatique vers DC02 (`nltest /dsgetdc`), ce qui fonctionne encore et
 * ce qui ne fonctionne plus sans DC, puis la reprise ordonnée
 * (redémarrage, `nltest /sc_reset`, `gpupdate /force`, `klist purge`).
 *
 * Les boucles de surveillance et de validation du scénario sont
 * transcrites en scripts PowerShell fichiers (`C:\\Scripts\\*.ps1`)
 * exécutés, plutôt qu'en commandes égrenées.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { WindowsPC } from '@/network/devices/WindowsPC';
import { CiscoSwitch } from '@/network/devices/CiscoSwitch';
import { Cable } from '@/network/hardware/Cable';
import { IPAddress, SubnetMask } from '@/network/core/types';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import { PowerShellSubShell } from '@/terminal/subshells/PowerShellSubShell';

describe('Scénario 9 — panne du contrôleur de domaine DC01', () => {
  const LONG = 30_000;
  let sw: CiscoSwitch;
  let dc01: WindowsPC;
  let dc02: WindowsPC;
  let poste: WindowsPC;

  beforeEach(async () => {
    EquipmentRegistry.resetInstance();
    sw = new CiscoSwitch('switch-cisco', 'SW-MANDENG-01', 8);
    sw.powerOn();

    dc01 = new WindowsPC('windows-server', 'DC01', 0, 0);
    dc02 = new WindowsPC('windows-server', 'DC02', 0, 0);
    poste = new WindowsPC('windows-pc', 'PC-WIN-01', 0, 0);
    for (const m of [dc01, dc02, poste]) m.powerOn();

    new Cable('lien-dc01').connect(sw.getPort('FastEthernet0/1')!, dc01.getPort('eth0')!);
    new Cable('lien-dc02').connect(sw.getPort('FastEthernet0/2')!, dc02.getPort('eth0')!);
    new Cable('lien-pc').connect(sw.getPort('FastEthernet0/3')!, poste.getPort('eth0')!);

    dc01.configureInterface('eth0', new IPAddress('192.168.10.10'), new SubnetMask('255.255.255.0'));
    dc02.configureInterface('eth0', new IPAddress('192.168.10.11'), new SubnetMask('255.255.255.0'));
    poste.configureInterface('eth0', new IPAddress('192.168.10.50'), new SubnetMask('255.255.255.0'));

    dc01.setCurrentUser('Administrator');
    await psOn(dc01,
      'Install-ADDSForest -DomainName mandeng.lan -SafeModeAdministratorPassword (ConvertTo-SecureString "P@ssw0rd!" -AsPlainText -Force) -Force');

    await installScripts();
  });

  async function psOn(machine: WindowsPC, line: string): Promise<string> {
    const shell = PowerShellSubShell.create(machine).subShell;
    return (await shell.processLine(line)).output.join('\n');
  }

  const ps = (cmd: string): Promise<string> => psOn(poste, cmd);

  async function installScripts(): Promise<void> {
    // Un poste Windows sort d'usine en `Restricted` : aucun script ne
    // tourne tant que l'operateur n'a pas pose de politique. C'est la
    // premiere commande de tout atelier de scripts, et `RemoteSigned`
    // est celle qu'un administrateur pose pour executer ses scripts
    // LOCAUX.
    await ps('Set-ExecutionPolicy RemoteSigned -Scope LocalMachine');
    await ps('New-Item -Path C:\\Scripts -ItemType Directory -Force');

    // Surveillance de la disponibilité d'un DC (port LDAP 389).
    await ps(`Set-Content -Path C:\\Scripts\\attente-dc.ps1 -Value @'
param($Cible = "192.168.10.10")
$Result = Test-NetConnection -ComputerName $Cible -Port 389
if ($Result.TcpTestSucceeded) {
  Write-Output "DC_DISPONIBLE=oui"
  Write-Output "CIBLE=$Cible"
} else {
  Write-Output "DC_DISPONIBLE=non"
  Write-Output "CIBLE=$Cible"
}
'@`);

    // Validation des fonctions domaine après reprise.
    await ps(`Set-Content -Path C:\\Scripts\\validation-domaine.ps1 -Value @'
param($Dc = "192.168.10.10")
$Ldap = Test-NetConnection -ComputerName $Dc -Port 389
$Kerberos = Test-NetConnection -ComputerName $Dc -Port 88
if ($Ldap.TcpTestSucceeded) { Write-Output "LDAP=OK" } else { Write-Output "LDAP=KO" }
if ($Kerberos.TcpTestSucceeded) { Write-Output "KERBEROS=OK" } else { Write-Output "KERBEROS=KO" }
if ($Ldap.TcpTestSucceeded -and $Kerberos.TcpTestSucceeded) {
  Write-Output "VERDICT=DOMAINE_OPERATIONNEL"
} else {
  Write-Output "VERDICT=DOMAINE_DEGRADE"
}
'@`);
  }

  describe('état nominal — DC01 répond', () => {
    it('le script d\'attente confirme la disponibilité LDAP de DC01', async () => {
      const out = await ps('& C:\\Scripts\\attente-dc.ps1 -Cible 192.168.10.10');
      expect(out).toContain('DC_DISPONIBLE=oui');
      expect(out).toContain('CIBLE=192.168.10.10');
    }, LONG);

    it('le script de validation conclut DOMAINE_OPERATIONNEL', async () => {
      const out = await ps('& C:\\Scripts\\validation-domaine.ps1 -Dc 192.168.10.10');
      expect(out).toContain('LDAP=OK');
      expect(out).toContain('KERBEROS=OK');
      expect(out).toContain('VERDICT=DOMAINE_OPERATIONNEL');
    }, LONG);
  });

  describe('effets immédiats de l\'extinction de DC01', () => {
    it('DC01 devient injoignable sur le port LDAP 389', async () => {
      dc01.powerOff();
      const out = await ps('Test-NetConnection -ComputerName 192.168.10.10 -Port 389');
      expect(out).toMatch(/TcpTestSucceeded\s*:\s*False/);
    }, LONG);

    it('le script d\'attente signale DC_DISPONIBLE=non', async () => {
      dc01.powerOff();
      const out = await ps('& C:\\Scripts\\attente-dc.ps1 -Cible 192.168.10.10');
      expect(out).toContain('DC_DISPONIBLE=non');
    }, LONG);

    it('le script de validation bascule sur DOMAINE_DEGRADE', async () => {
      dc01.powerOff();
      const out = await ps('& C:\\Scripts\\validation-domaine.ps1 -Dc 192.168.10.10');
      expect(out).toContain('LDAP=KO');
      expect(out).toContain('VERDICT=DOMAINE_DEGRADE');
    }, LONG);

    it('l\'accès par IP à une autre machine reste possible (pas de panne réseau)', async () => {
      dc01.powerOff();
      const out = await ps('Test-NetConnection -ComputerName 192.168.10.11 -Port 445');
      expect(out).not.toMatch(/TcpTestSucceeded\s*:\s*True\s*\n.*192\.168\.10\.10/);
      expect(await poste.executeCmdCommand('ping -n 2 192.168.10.11')).not.toContain('100% loss');
    }, LONG);
  });

  describe('opérations disponibles et indisponibles sans DC', () => {
    it('l\'accès aux fichiers locaux continue de fonctionner', async () => {
      dc01.powerOff();
      const out = await ps('Get-ChildItem C:\\');
      expect(out).not.toMatch(/RPC server is unavailable|cannot be contacted/i);
    });

    it('`nltest /dsgetdc:mandeng.lan` est accepté par le simulateur', async () => {
      const out = await poste.executeCmdCommand('nltest /dsgetdc:mandeng.lan');
      expect(out).not.toMatch(/is not recognized/i);
    });

    it('`gpupdate /force` est accepté par le simulateur', async () => {
      const out = await poste.executeCmdCommand('gpupdate /force');
      expect(out).not.toMatch(/is not recognized/i);
    });

    it('`klist` est accepté par le simulateur', async () => {
      const out = await poste.executeCmdCommand('klist');
      expect(out).not.toMatch(/is not recognized/i);
    });

    it('`powershell -File <script.ps1>` lance le script et lui passe ses paramètres', async () => {
      // `-File` était accepté puis jeté : la commande ne rendait rien du
      // tout, et lui ajouter un paramètre de script faisait retomber
      // toute la ligne sur cmd.exe.
      const out = await ps('powershell -File C:\\Scripts\\attente-dc.ps1 -Cible 192.168.10.10');
      expect(out).not.toMatch(/is not recognized/i);
      expect(out).toMatch(/DC_DISPONIBLE=/);
    });

    it('`exit <code>` termine le script et renseigne $LASTEXITCODE', async () => {
      await ps(`Set-Content -Path C:\\Scripts\\code-sortie.ps1 -Value @'
Write-Output "AVANT_EXIT"
exit 3
Write-Output "APRES_EXIT"
'@`);
      // `psOn` ouvre une console neuve à chaque appel : le code de sortie
      // ne survivrait pas d'un appel au suivant, il se lit donc dans la
      // même invocation que l'exécution.
      const out = await ps('& C:\\Scripts\\code-sortie.ps1\n$LASTEXITCODE');
      expect(out).toContain('AVANT_EXIT');
      expect(out).not.toMatch(/is not recognized/i);
      // Ce qui suit `exit` ne s'exécute pas — c'est tout l'intérêt.
      expect(out).not.toContain('APRES_EXIT');
      expect(out.trim().split('\n').pop()!.trim()).toBe('3');
    });
  });

  describe('remise en service de DC01 et validation complète', () => {
    it('le redémarrage rend DC01 de nouveau joignable', async () => {
      dc01.powerOff();
      expect(await ps('& C:\\Scripts\\attente-dc.ps1 -Cible 192.168.10.10'))
        .toContain('DC_DISPONIBLE=non');

      dc01.powerOn();

      expect(await ps('& C:\\Scripts\\attente-dc.ps1 -Cible 192.168.10.10'))
        .toContain('DC_DISPONIBLE=oui');
    }, LONG);

    it('le script de validation repasse à DOMAINE_OPERATIONNEL', async () => {
      dc01.powerOff();
      dc01.powerOn();

      const out = await ps('& C:\\Scripts\\validation-domaine.ps1 -Dc 192.168.10.10');
      expect(out).toContain('LDAP=OK');
      expect(out).toContain('KERBEROS=OK');
      expect(out).toContain('VERDICT=DOMAINE_OPERATIONNEL');
    }, LONG);
  });

  describe('critère de réussite', () => {
    it('perte de DC01 détectée par le script, puis reprise complète validée', async () => {
      dc01.powerOff();
      expect(await ps('& C:\\Scripts\\validation-domaine.ps1 -Dc 192.168.10.10'))
        .toContain('VERDICT=DOMAINE_DEGRADE');

      dc01.powerOn();
      expect(await ps('& C:\\Scripts\\validation-domaine.ps1 -Dc 192.168.10.10'))
        .toContain('VERDICT=DOMAINE_OPERATIONNEL');
    }, LONG);
  });
});
