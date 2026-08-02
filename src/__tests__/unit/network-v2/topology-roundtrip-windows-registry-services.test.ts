/**
 * Ce qu'un poste Windows avait fait de sa base de registre et de ses
 * services, et qu'une sauvegarde de topologie perdait.
 *
 * Le registre et le gestionnaire de services vivent sur l'objet
 * `WindowsPC` et nulle part ailleurs : aucun fichier ne les décrit, aucun
 * texte de configuration ne les rejoue à l'import. La sérialisation ne
 * les regardait pas, donc un TP entier — « désactivez le service Spooler
 * et posez la stratégie qui l'accompagne » — revenait d'un
 * Enregistrer/Ouvrir exactement comme une machine sortie d'usine, sans
 * un mot.
 *
 * Deux règles gouvernent ce qui est écrit, et les deux comptent :
 *
 *   - c'est un DIFF contre une ruche vierge de la même édition, pas un
 *     vidage. Un vidage de la ruche amorcée dans chaque fichier de
 *     topologie enterrerait la seule valeur qu'un TP a posée.
 *   - les SUPPRESSIONS sont portées explicitement. La moitié de ce qu'on
 *     fait à une base de registre consiste à retirer une valeur ou une
 *     clé amorcée ; une capture qui ne listerait que le présent les
 *     ferait toutes revenir au chargement suivant — la machine
 *     annulerait l'exercice en silence.
 *
 * Tout passe par les vraies commandes de la machine (`reg`, `sc`,
 * PowerShell) et par le vrai exportateur/importateur ; ce que le test
 * interroge après le tour, c'est la machine, pas le JSON.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { WindowsPC } from '@/network/devices/WindowsPC';
import { WindowsServer } from '@/network/devices/WindowsServer';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import { exportTopology, importTopology } from '@/store/topologySerializer';
import type { Equipment } from '@/network/equipment/Equipment';

beforeEach(() => {
  EquipmentRegistry.getInstance().clear();
});

/** Un poste allumé, ouvert par un administrateur. */
function box(name = 'WIN1'): WindowsPC {
  const pc = new WindowsPC('windows-pc', name);
  pc.setCurrentUser('Administrator');
  pc.powerOn();
  return pc;
}

/** Enregistrer puis rouvrir, comme l'UI le fait — par le JSON. */
async function roundTrip(devices: Equipment[]): Promise<Map<string, Equipment>> {
  const instances = new Map<string, Equipment>(devices.map((d) => [d.getId(), d]));
  const json = exportTopology('lab', instances, []);
  const reopened = await importTopology(JSON.parse(JSON.stringify(json)));
  return reopened.deviceInstances;
}

const byName = (m: Map<string, Equipment>, name: string): WindowsPC =>
  [...m.values()].find((d) => d.getName() === name)! as WindowsPC;

describe('la base de registre survit à un enregistrement', () => {
  it('une valeur posée par `reg add` est encore là après réouverture', async () => {
    const pc = box();
    await pc.executeCommand('reg add HKLM\\SOFTWARE\\Lab /v Site /d Douala /f');

    const back = byName(await roundTrip([pc]), 'WIN1');

    expect(await back.executeCommand('reg query HKLM\\SOFTWARE\\Lab')).toContain('Douala');
  });

  it('une valeur posée par PowerShell revient aussi — un seul magasin', async () => {
    const pc = box();
    await pc.executeCommand('reg add HKLM\\SOFTWARE\\Lab /v Site /d Douala /f');
    await pc.executeCommand(
      'powershell -Command "Set-ItemProperty -Path HKLM:\\SOFTWARE\\Lab -Name Ville -Value Yaounde"',
    );

    const back = byName(await roundTrip([pc]), 'WIN1');

    const out = await back.executeCommand('reg query HKLM\\SOFTWARE\\Lab');
    expect(out).toContain('Douala');
    expect(out).toContain('Yaounde');
  });

  it('un REG_DWORD revient en nombre, pas en chaîne', async () => {
    const pc = box();
    await pc.executeCommand(
      'reg add HKLM\\SOFTWARE\\Lab /v Seuil /t REG_DWORD /d 16 /f',
    );

    const back = byName(await roundTrip([pc]), 'WIN1');

    // `reg query` rend un DWORD en hexadécimal et une chaîne telle
    // quelle : c'est ce qui distingue les deux à l'écran.
    expect(await back.executeCommand('reg query HKLM\\SOFTWARE\\Lab')).toContain('0x10');
  });

  it('une valeur amorcée que le TP a supprimée ne revient pas', async () => {
    const pc = box();
    // Une valeur que l'image livre — la supprimer est un geste de TP,
    // pas un accident.
    const seeded = 'HKLM\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion';
    expect(await pc.executeCommand(`reg query "${seeded}" /v EditionID`)).toContain('EditionID');
    await pc.executeCommand(`reg delete "${seeded}" /v EditionID /f`);

    const back = byName(await roundTrip([pc]), 'WIN1');

    expect(await back.executeCommand(`reg query "${seeded}" /v EditionID`))
      .not.toContain('EditionID');
  });

  it('une clé amorcée supprimée en entier ne revient pas non plus', async () => {
    const pc = box();
    const seeded = 'HKLM\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion';
    await pc.executeCommand(`reg delete "${seeded}" /f`);

    const back = byName(await roundTrip([pc]), 'WIN1');

    expect(await back.executeCommand(`reg query "${seeded}"`))
      .toContain('ERROR: The system was unable to find');
  });

  it('une machine intacte n\'écrit rien : le fichier ne porte que ce qui a changé', () => {
    const pc = box();
    const json = exportTopology('lab', new Map([[pc.getId(), pc as Equipment]]), []);

    // Pas de ruche vidée dans le fichier — sinon la seule valeur qu'un TP
    // pose serait noyée dans des centaines de lignes d'usine.
    expect(json.devices[0].registry).toBeUndefined();
  });

  it('un serveur intact non plus — la ruche de référence est de la bonne édition', () => {
    const srv = new WindowsServer('SRV1');
    srv.powerOn();
    const json = exportTopology('lab', new Map([[srv.getId(), srv as Equipment]]), []);

    // Un serveur comparé à une ruche cliente déclarerait son numéro de
    // build, son `EditionID` et son `InstallationType` comme des
    // modifications d'opérateur, dans chaque fichier de topologie.
    expect(json.devices[0].registry).toBeUndefined();
  });
});

describe('les services survivent à un enregistrement', () => {
  it('un service désactivé revient désactivé', async () => {
    const pc = box();
    await pc.executeCommand('sc config Spooler start= disabled');
    await pc.executeCommand('sc stop Spooler');

    const back = byName(await roundTrip([pc]), 'WIN1');

    const svc = back.getServiceManager().getService('Spooler')!;
    expect(svc.startType).toBe('Disabled');
    expect(svc.state).toBe('Stopped');
  });

  it('un service arrêté à la main ne redémarre pas tout seul', async () => {
    const pc = box();
    expect(pc.getServiceManager().getService('Spooler')!.state).toBe('Running');
    await pc.executeCommand('sc stop Spooler');

    const back = byName(await roundTrip([pc]), 'WIN1');

    // Sans capture d'état, la politique de démarrage du SCM relance un
    // service Automatique au boot — et le TP « diagnostiquez pourquoi
    // l'impression ne marche pas » n'a plus de panne.
    expect(await back.executeCommand('sc query Spooler')).toContain('STOPPED');
  });

  it('un service créé par `sc create` existe encore', async () => {
    const pc = box();
    await pc.executeCommand(
      'sc create LabAgent binPath= "C:\\Lab\\agent.exe" DisplayName= "Agent du labo"',
    );

    const back = byName(await roundTrip([pc]), 'WIN1');

    const svc = back.getServiceManager().getService('LabAgent');
    expect(svc).toBeDefined();
    expect(svc!.binaryPath).toBe('C:\\Lab\\agent.exe');
    expect(svc!.displayName).toBe('Agent du labo');
  });

  it('un service désactivé ALORS QU\'IL TOURNAIT revient dans cet état', async () => {
    const pc = box();
    // Le SCM refuse de démarrer un service désactivé : restaurer l'état
    // après le type de démarrage donnerait une machine où le service est
    // arrêté, ce qui n'est pas ce qui a été enregistré.
    await pc.executeCommand('sc config Spooler start= disabled');
    expect(pc.getServiceManager().getService('Spooler')!.state).toBe('Running');

    const back = byName(await roundTrip([pc]), 'WIN1');

    const svc = back.getServiceManager().getService('Spooler')!;
    expect(svc.state).toBe('Running');
    expect(svc.startType).toBe('Disabled');
  });

  it('une machine intacte n\'écrit aucun service', () => {
    const pc = box();
    const json = exportTopology('lab', new Map([[pc.getId(), pc as Equipment]]), []);

    expect(json.devices[0].windowsServices).toBeUndefined();
  });
});

describe('le registre et les services racontent la même chose après réouverture', () => {
  it('la clé de service et le gestionnaire de services s\'accordent', async () => {
    const pc = box();
    await pc.executeCommand('sc create LabAgent binPath= "C:\\Lab\\agent.exe"');
    await pc.executeCommand('sc config LabAgent obj= "NT AUTHORITY\\LocalService"');

    const back = byName(await roundTrip([pc]), 'WIN1');

    // `sc qc` lit le gestionnaire, `reg query` lit la ruche : les deux
    // décrivent le même service et doivent tomber d'accord.
    expect(await back.executeCommand('sc qc LabAgent')).toContain('NT AUTHORITY\\LocalService');
    expect(await back.executeCommand(
      'reg query HKLM\\SYSTEM\\CurrentControlSet\\Services\\LabAgent',
    )).toContain('NT AUTHORITY\\LocalService');
  });
});
