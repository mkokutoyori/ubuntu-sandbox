/**
 * Sonde — `sudo NOM=valeur commande` pose la variable pour la commande.
 *
 * Mesure d'origine (lab NTP, section 0.4, `sudo DEBIAN_FRONTEND=noninteractive apt install -y ...`) : `sudo` prenait
 * `NOM=valeur` pour le NOM DE LA COMMANDE et répondait `NOM=valeur: command not found`. Le sudo de `sudo(8)` accepte, avant
 * la commande, des affectations d'environnement que `sudoers` autorise (`env_reset` les laisse passer par défaut quand elles
 * sont tapées sur la ligne de commande).
 *
 * Discrimination `git stash` : 2 cas tombent avant le correctif — « a variable typed after sudo reaches the command » et
 * « several variables reach the command ».
 *
 * Passent des deux côtés, et pourquoi :
 *  - « TEMOIN: sudo runs a plain command » — prouve que `sudo` marche, donc qu'un échec des autres accuse l'affectation.
 *  - « the variable does not leak into the shell afterwards » — ABSENCE : avant, l'appel échouait avant d'atteindre la
 *    commande, donc rien ne fuyait. Le cas garde le correctif d'une fuite qui rendrait l'affectation permanente ; les deux
 *    cas ci-dessus prouvent, dans le même état, que la variable atteint bien la commande.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import { MACAddress, resetCounters } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  MACAddress.resetCounter();
  Logger.reset();
  EquipmentRegistry.resetInstance();
});

describe('Probe — sudo NAME=value command', () => {
  it('TEMOIN: sudo runs a plain command', async () => {
    const pc = new LinuxPC('linux-pc', 'PC1');
    pc.powerOn();
    expect(await pc.executeCommand('sudo whoami')).toBe('root');
  });

  it('a variable typed after sudo reaches the command', async () => {
    const pc = new LinuxPC('linux-pc', 'PC1');
    pc.powerOn();
    expect(await pc.executeCommand('sudo DEBIAN_FRONTEND=noninteractive printenv DEBIAN_FRONTEND')).toBe('noninteractive');
  });

  it('several variables reach the command', async () => {
    const pc = new LinuxPC('linux-pc', 'PC1');
    pc.powerOn();
    expect(await pc.executeCommand('sudo A=1 B=2 sh -c \'echo "$A$B"\'')).toBe('12');
  });

  it('the variable does not leak into the shell afterwards', async () => {
    const pc = new LinuxPC('linux-pc', 'PC1');
    pc.powerOn();
    await pc.executeCommand('sudo DEBIAN_FRONTEND=noninteractive true');
    expect(await pc.executeCommand('printenv DEBIAN_FRONTEND; echo "rc=$?"')).toBe('rc=1');
  });
});
