/**
 * `nmap` n'est pas une commande Linux. Il existe sous Windows depuis
 * toujours, en `nmap.exe`, et une machine Windows de ce simulateur n'en
 * avait aucun — `nmap` repondait « is not recognized as an internal or
 * external command ».
 *
 * L'ajouter en dupliquant l'implantation aurait produit la derive que ce
 * projet referme ailleurs (deux registres Windows, deux piles SSH, deux
 * tcpdump) : deux `nmap` qui finissent par ne plus dire la meme chose de
 * la meme situation. Le moteur vit donc dans `src/network/scan/nmap/`, et
 * chaque plateforme ne fournit que son propre branchement — `ScanHost` :
 * fichier hosts, echo ICMP, sortie TCP, salutation, sonde UDP.
 *
 * Ce fichier verifie la propriete qui compte : LA MEME SITUATION DONNE LE
 * MEME VERDICT DES DEUX COTES, sans que le test connaisse le chemin.
 *
 * Le TEMOIN est le poste Linux : son `nmap` fonctionnait deja, donc un
 * ecart entre les deux colonnes accuse la nouvelle moitie et non le
 * laboratoire.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { WindowsPC } from '@/network/devices/WindowsPC';
import { GenericSwitch } from '@/network/devices/GenericSwitch';
import { Cable } from '@/network/hardware/Cable';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import { IPAddress, SubnetMask, resetCounters, MACAddress } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';

const SRV_IP = '10.42.0.10';
const LNX_IP = '10.42.0.20';
const WIN_IP = '10.42.0.30';

beforeEach(() => {
  resetCounters(); resetDeviceCounters(); MACAddress.resetCounter(); Logger.reset();
  EquipmentRegistry.resetInstance();
});

async function lab() {
  const server = new LinuxServer('linux-server', 'CIBLE');
  const linux = new LinuxPC('linux-pc', 'LNX');
  const windows = new WindowsPC('windows-pc', 'WIN');
  const sw = new GenericSwitch('switch-generic', 'SW');
  new Cable('c1').connect(server.getPorts()[0], sw.getPorts()[0]);
  new Cable('c2').connect(linux.getPorts()[0], sw.getPorts()[1]);
  new Cable('c3').connect(windows.getPorts()[0], sw.getPorts()[2]);
  const mask = new SubnetMask('255.255.255.0');
  server.getPorts()[0].configureIP(new IPAddress(SRV_IP), mask);
  linux.getPorts()[0].configureIP(new IPAddress(LNX_IP), mask);
  windows.getPorts()[0].configureIP(new IPAddress(WIN_IP), mask);
  server.powerOn(); linux.powerOn(); windows.powerOn();
  await server.executeCommand('sudo systemctl start ssh');
  return { server, linux, windows };
}

describe('nmap.exe existe sous Windows', () => {
  it('la commande est reconnue', async () => {
    const { windows } = await lab();

    const sortie = await windows.executeCommand(`nmap -Pn -p 22 ${SRV_IP}`);

    expect(sortie).not.toMatch(/is not recognized/);
    expect(sortie).toContain('Nmap');
  });

  it('`nmap.exe` et `nmap` sont la meme commande', async () => {
    const { windows } = await lab();

    const court = await windows.executeCommand(`nmap -Pn -p 22 ${SRV_IP}`);
    const long = await windows.executeCommand(`nmap.exe -Pn -p 22 ${SRV_IP}`);

    // La duree et la latence sont deux MESURES : deux balayages du meme
    // hote n'en donnent pas les memes chiffres, sur une vraie machine
    // comme ici. Ce que ce cas compare est le reste.
    const sansMesures = (s: string) => s
      .replace(/in [\d.]+ seconds/, '')
      .replace(/\([\d.]+s latency\)/, '');
    expect(sansMesures(long)).toBe(sansMesures(court));
  });

  it('PowerShell le passe a la commande native', async () => {
    const { windows } = await lab();

    const sortie = await windows.executeCommand(
      `powershell -Command "nmap -Pn -p 22 ${SRV_IP}"`);

    expect(sortie).toMatch(/22\/tcp\s+open\s+ssh/);
  });
});

describe('les deux plateformes rendent le meme verdict', () => {
  it('un port ouvert est ouvert des deux cotes', async () => {
    const { linux, windows } = await lab();

    const cotelinux = await linux.executeCommand(`nmap -Pn -p 22 ${SRV_IP}`);
    const coteWindows = await windows.executeCommand(`nmap -Pn -p 22 ${SRV_IP}`);

    expect(cotelinux).toMatch(/22\/tcp\s+open\s+ssh/);
    expect(coteWindows).toMatch(/22\/tcp\s+open\s+ssh/);
  });

  it('un port ferme est ferme des deux cotes', async () => {
    const { linux, windows } = await lab();

    const cotelinux = await linux.executeCommand(`nmap -Pn -p 8888 ${SRV_IP}`);
    const coteWindows = await windows.executeCommand(`nmap -Pn -p 8888 ${SRV_IP}`);

    expect(cotelinux).toMatch(/8888\/tcp\s+closed/);
    expect(coteWindows).toMatch(/8888\/tcp\s+closed/);
  });

  it('la decouverte d hote declare la cible vivante des deux cotes', async () => {
    const { linux, windows } = await lab();

    const cotelinux = await linux.executeCommand(`nmap -sn ${SRV_IP}`);
    const coteWindows = await windows.executeCommand(`nmap -sn ${SRV_IP}`);

    expect(cotelinux).toMatch(/Host is up/);
    expect(coteWindows).toMatch(/Host is up/);
  });

  it('une adresse que personne ne porte n est vivante d aucun cote', async () => {
    const { linux, windows } = await lab();

    const cotelinux = await linux.executeCommand('nmap -sn 10.42.0.99');
    const coteWindows = await windows.executeCommand('nmap -sn 10.42.0.99');

    expect(cotelinux).not.toMatch(/Host is up/);
    expect(coteWindows).not.toMatch(/Host is up/);
  });

  it('`-sV` lit la meme banniere des deux cotes', async () => {
    const { linux, windows } = await lab();

    const cotelinux = await linux.executeCommand(`nmap -Pn -sV -p 22 ${SRV_IP}`);
    const coteWindows = await windows.executeCommand(`nmap -Pn -sV -p 22 ${SRV_IP}`);

    const version = /22\/tcp\s+open\s+ssh\s+(\S+)/.exec(cotelinux);
    expect(version).not.toBeNull();
    expect(coteWindows).toContain(version![1]);
  });

  it('`-O` nomme la meme famille des deux cotes', async () => {
    const { linux, windows } = await lab();

    const cotelinux = await linux.executeCommand(`nmap -O -p 22 ${SRV_IP}`);
    const coteWindows = await windows.executeCommand(`nmap -O -p 22 ${SRV_IP}`);

    expect(cotelinux).toMatch(/Linux/);
    expect(coteWindows).toMatch(/Linux/);
  });

  it('`-oN` ecrit son rapport sur les deux systemes de fichiers', async () => {
    const { linux, windows } = await lab();

    await linux.executeCommand(`nmap -Pn -oN /tmp/scan.txt -p 22 ${SRV_IP}`);
    await windows.executeCommand(`nmap -Pn -oN C:\\scan.txt -p 22 ${SRV_IP}`);

    expect(await linux.executeCommand('cat /tmp/scan.txt')).toMatch(/22\/tcp\s+open/);
    expect(await windows.executeCommand('type C:\\scan.txt')).toMatch(/22\/tcp\s+open/);
  });
});
