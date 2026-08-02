/**
 * `sc qc` et `reg query` sont deux lectures d'un seul fait.
 *
 * Sur une vraie machine, la configuration d'un service N'EST PAS ailleurs
 * que dans `HKLM:\SYSTEM\CurrentControlSet\Services\<nom>` : c'est cette
 * clé que le SCM relit au démarrage, et `sc config` l'écrit. Ici, la
 * projection n'était rejouée que sur `windows.service.account-changed`,
 * donc `sc config <svc> start= disabled` changeait le service et laissait
 * la valeur `Start` de la ruche telle quelle — l'opérateur voyait
 * DISABLED d'un côté et `Start=2` (AUTO_START) de l'autre, sur la même
 * machine, au même instant. Le genre de contradiction où le diagnostic
 * ne tombe jamais juste.
 *
 * Corrigé à la racine plutôt qu'en ajoutant un abonné de plus : le
 * gestionnaire de services écrit lui-même dans la ruche, à travers un
 * port étroit (`ServiceRegistrySink`). Une mutation ne peut plus oublier
 * de s'annoncer, puisqu'il n'y a plus rien à annoncer.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { WindowsPC } from '@/network/devices/WindowsPC';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';

const SERVICES = 'HKLM\\SYSTEM\\CurrentControlSet\\Services';

beforeEach(() => {
  EquipmentRegistry.getInstance().clear();
});

function box(): WindowsPC {
  const pc = new WindowsPC('windows-pc', 'WIN1');
  pc.setCurrentUser('Administrator');
  pc.powerOn();
  return pc;
}

/** La valeur `Start` que la ruche porte pour ce service. */
async function startValue(pc: WindowsPC, service: string): Promise<string> {
  const out = await pc.executeCommand(`reg query ${SERVICES}\\${service} /v Start`);
  return out.split('\n').find((l) => l.includes('Start'))?.trim() ?? out;
}

describe('le type de démarrage est le même des deux côtés', () => {
  it('`sc config start= disabled` met `Start` à 4 dans la ruche', async () => {
    const pc = box();
    // 2 = AUTO_START, l'état d'usine du Spooler.
    expect(await startValue(pc, 'Spooler')).toContain('0x2');

    await pc.executeCommand('sc config Spooler start= disabled');

    expect(await pc.executeCommand('sc qc Spooler')).toContain('DISABLED');
    // 4 = SERVICE_DISABLED, la valeur que le SCM relira au démarrage.
    expect(await startValue(pc, 'Spooler')).toContain('0x4');
  });

  it('`sc config start= demand` puis `auto` suivent tous les deux', async () => {
    const pc = box();

    await pc.executeCommand('sc config Spooler start= demand');
    expect(await startValue(pc, 'Spooler')).toContain('0x3');

    await pc.executeCommand('sc config Spooler start= auto');
    expect(await startValue(pc, 'Spooler')).toContain('0x2');
  });

  it('`Set-Service -StartupType` aussi — c\'est le même gestionnaire', async () => {
    const pc = box();

    await pc.executeCommand(
      'powershell -Command "Set-Service -Name Spooler -StartupType Disabled"',
    );

    expect(await startValue(pc, 'Spooler')).toContain('0x4');
  });
});

describe('le compte et le cycle de vie du service suivent aussi', () => {
  it('`sc config obj=` met `ObjectName` à jour', async () => {
    const pc = box();

    await pc.executeCommand('sc config Spooler obj= "NT AUTHORITY\\LocalService"');

    expect(await pc.executeCommand(`reg query ${SERVICES}\\Spooler`))
      .toContain('NT AUTHORITY\\LocalService');
  });

  it('`sc create` fait apparaître la clé, `sc delete` l\'emporte avec lui', async () => {
    const pc = box();

    await pc.executeCommand('sc create LabAgent binPath= "C:\\Lab\\agent.exe"');
    expect(await pc.executeCommand(`reg query ${SERVICES}\\LabAgent`))
      .toContain('C:\\Lab\\agent.exe');

    await pc.executeCommand('sc delete LabAgent');

    // Laisser la clé derrière ferait relire au SCM, au prochain
    // démarrage, un service que plus personne ne peut lancer.
    expect(await pc.executeCommand(`reg query ${SERVICES}\\LabAgent`))
      .toContain('ERROR: The system was unable to find');
  });

  it('un refus ne touche à rien : un utilisateur standard ne change pas la ruche', async () => {
    const pc = new WindowsPC('windows-pc', 'WIN2');
    pc.powerOn(); // ouvert sur `User`, comme un vrai poste client

    expect(await pc.executeCommand('sc config Spooler start= disabled'))
      .toContain('Access is denied');
    expect(await startValue(pc, 'Spooler')).toContain('0x2');
  });
});
