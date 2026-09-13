/**
 * `netstat` ne montre que les connexions qui ont VRAIMENT eu lieu.
 *
 * Ecrite a l'aveugle depuis le comportement de Windows : une connexion
 * n'apparait dans `netstat -ano` que si la pile l'a reellement ouverte.
 * Un `ssh` qui echoue avant le moindre paquet — pile locale sans adresse,
 * nom qui ne se resout pas — ne laisse aucune ligne.
 *
 * Le poste Windows decidait par une LISTE NEGATIVE de messages d'erreur
 * (`Permission denied|refused|timed out|Could not resolve|No route`) : tout
 * ce qui n'y figurait pas comptait comme un succes. « Network is unreachable »
 * n'y figurait pas, donc un `ssh` depuis une machine sans adresse inscrivait
 * une connexion TIME_WAIT vers un pair jamais joint. Le code de sortie du
 * client dit la meme chose sans avoir a deviner.
 *
 * La cible etait de surcroit reconnue par `^\d{1,3}(?:\.\d{1,3}){3}$`, qui
 * accepte `999.999.999.999`. C'est `IPAddress` qui decide maintenant.
 *
 * Mesure avant correction : 1 cas tombe sur 4 — celui de la machine sans
 * adresse. Les 3 autres passent des deux cotes, et c'est voulu :
 *   - « une connexion REUSSIE se voit dans netstat » est le TEMOIN qui
 *     prouve que ce laboratoire sait produire une ligne quand il le faut,
 *     sans quoi une sonde faite de refus ne prouverait rien ;
 *   - « un nom inconnu est refuse avec les mots d OpenSSH » est le TEMOIN
 *     de la fidelite du message de resolution ;
 *   - « une cible qui n est pas une adresse » est une NON-REGRESSION : la
 *     liste negative contenait deja « Could not resolve », donc ce cas-la
 *     etait juste par accident. C'est precisement ce que la liste negative
 *     a d'inquietant, et pourquoi le code de sortie la remplace.
 *
 * La conversion de `^\d{1,3}(?:\.\d{1,3}){3}$` vers `IPAddress` qui
 * accompagne ce correctif n'a PAS de cas propre ici : une fois l'inscription
 * decidee par le code de sortie, le pair n'est lu que sur un succes, ou
 * l'adresse est forcement valide. C'est de l'hygiene de regle, pas un
 * comportement que cette sonde demontre.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { resetCounters, MACAddress, IPAddress, SubnetMask } from '@/network/core/types';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { WindowsPC } from '@/network/devices/WindowsPC';
import { Cable } from '@/network/hardware/Cable';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  MACAddress.resetCounter();
  Logger.reset();
});

function isole(): WindowsPC {
  const pc = new WindowsPC('windows-pc', 'WIN1', 0, 0);
  pc.powerOn();
  return pc;
}

async function labo(): Promise<{ win: WindowsPC; srv: LinuxServer }> {
  const win = new WindowsPC('windows-pc', 'WIN1', 0, 0);
  const srv = new LinuxServer('linux-server', 'SRV1');
  win.powerOn(); srv.powerOn();
  new Cable('c1').connect(win.getPorts()[0], srv.getPorts()[0]);
  const m = new SubnetMask('255.255.255.0');
  win.getPorts()[0].configureIP(new IPAddress('10.0.0.1'), m);
  srv.getPorts()[0].configureIP(new IPAddress('10.0.0.2'), m);
  await srv.executeCommand('sudo systemctl start ssh');
  await srv.executeCommand('sudo useradd -m alice');
  await srv.executeCommand('echo "alice:secret123" | sudo chpasswd');
  return { win, srv };
}

describe('netstat n inscrit rien pour un ssh qui n a jamais atteint le fil', () => {
  it('une machine SANS adresse ne laisse aucune connexion', async () => {
    const pc = isole();
    const refus = await pc.executeCommand('ssh 10.0.0.9');
    expect(refus).toContain('Network is unreachable');
    const netstat = await pc.executeCommand('netstat -ano');
    expect(netstat).not.toContain('10.0.0.9');
  });

  it('une cible qui n est pas une adresse ne laisse aucune connexion', async () => {
    const { win } = await labo();
    const refus = await win.executeCommand('ssh 999.999.999.999');
    expect(refus).toContain('Could not resolve hostname 999.999.999.999');
    const netstat = await win.executeCommand('netstat -ano');
    expect(netstat).not.toContain('999.999.999.999');
  });

  it('un nom inconnu est refuse avec les mots d OpenSSH', async () => {
    const { win } = await labo();
    const refus = await win.executeCommand('ssh zorglub.example');
    expect(refus).toContain('Could not resolve hostname zorglub.example: Name or service not known');
  });

  it('une connexion REUSSIE, elle, se voit dans netstat', async () => {
    const { win } = await labo();
    await win.executeCommand('ssh -o StrictHostKeyChecking=no alice@10.0.0.2 hostname');
    const netstat = await win.executeCommand('netstat -ano');
    expect(netstat).toContain('10.0.0.2:22');
  });
});
