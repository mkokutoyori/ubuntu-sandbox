/**
 * La cle d'hote d'un equipement est une cle ED25519 AU FORMAT DU FIL.
 *
 * Ecrite a l'aveugle depuis le standard adopte, pas depuis le depot :
 * RFC 8709 §4 fixe la cle publique ed25519 de SSH a
 *
 *     string "ssh-ed25519"  ||  string <32 octets>
 *
 * soit 4 + 11 + 4 + 32 = 51 octets. 51 est un multiple de 3, donc son
 * base64 fait exactement 68 caracteres SANS remplissage, et son debut est
 * entierement determine par le prefixe constant :
 *
 *     00 00 00 0b | "ssh-ed25519" | 00 00 00 20 | <cle>
 *     AAAA  C3Nz    aC1l ZDI1 NTE5   AAAA  I...
 *
 * d'ou le prefixe « AAAAC3NzaC1lZDI1NTE5AAAAI » que porte TOUTE cle
 * ed25519 reelle. Ce n'est pas un souvenir : c'est de l'arithmetique sur
 * l'encodage que la RFC impose.
 *
 * L'empreinte que `ssh-keyscan`/`known_hosts` affichent est le SHA-256 de
 * ces 51 octets decodes, pas d'autre chose.
 *
 * Le depot ecrit ce fait DEUX FOIS : `SshKeygenMaterial` construit le vrai
 * blob (c'est ce que `ssh-keygen` produit), tandis que `SshHostKey.generate`
 * rend 43 caracteres base64 derives d'un sha256 — ni encadres, ni de la
 * bonne longueur. Comme `SshHostKey.generate` sert les cinq porteurs de
 * cle d'hote du simulateur (contexte Linux, contexte Windows, Router,
 * FirewallCliServer, SshPureUtils), TOUS presentent une cle mal formee,
 * et une MEME machine Windows en presente une bonne apres `ssh-keygen -A`
 * et une mauvaise avant : deux reponses a une seule question.
 *
 * Mesure avant correction : 5 cas tombent sur 7. Les 2 qui passent des deux
 * cotes sont nommes :
 *   - « `ssh-keygen -A` ecrit deja le bon format » est le TEMOIN, et c'est
 *     la reponse que les quatre autres porteurs doivent rejoindre ;
 *   - « une machine ne presente pas DEUX cles selon la vue » passait DEJA,
 *     parce que le disque et le fil s'accordaient... sur la mauvaise cle.
 *     Il reste utile : il interdit que la correction ne rattrape qu'une
 *     des deux vues.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { resetCounters, MACAddress, IPAddress, SubnetMask } from '@/network/core/types';
import { WindowsPC } from '@/network/devices/WindowsPC';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { GenericSwitch } from '@/network/devices/GenericSwitch';
import { Cable } from '@/network/hardware/Cable';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { SshHostKey } from '@/network/protocols/ssh/SshHostKey';
import { sha256, bytesToBase64, utf8ToBytes } from '@/crypto';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  MACAddress.resetCounter();
  Logger.reset();
});

const PREFIXE_ED25519 = 'AAAAC3NzaC1lZDI1NTE5AAAAI';

function blobDe(ligne: string): string {
  const champs = ligne.trim().split(/\s+/);
  return champs[champs.length - 1].includes('@') ? champs[champs.length - 2] : champs[champs.length - 1];
}

function estUneCleDuFil(blob: string): boolean {
  return blob.startsWith(PREFIXE_ED25519) && blob.length === 68 && !blob.includes('=');
}

async function labo(): Promise<{ win: WindowsPC; pc: LinuxPC; srv: LinuxServer }> {
  const win = new WindowsPC('windows-pc', 'WIN1', 0, 0);
  const pc = new LinuxPC('linux-pc', 'PC1', 0, 0);
  const srv = new LinuxServer('linux-server', 'SRV1');
  const sw = new GenericSwitch('switch-generic', 'SW1', 8, 0, 0);
  [win, pc, srv].forEach((d, i) => {
    d.powerOn();
    new Cable(`c${i}`).connect(d.getPorts()[0], sw.getPorts()[i]);
  });
  const m = new SubnetMask('255.255.255.0');
  win.getPorts()[0].configureIP(new IPAddress('10.0.0.1'), m);
  pc.getPorts()[0].configureIP(new IPAddress('10.0.0.3'), m);
  srv.getPorts()[0].configureIP(new IPAddress('10.0.0.2'), m);
  await srv.executeCommand('sudo systemctl start ssh');
  return { win, pc, srv };
}

describe('toute cle d hote presentee porte le format du fil', () => {
  it('TEMOIN : `ssh-keygen -A` ecrit deja le bon format', async () => {
    const { win } = await labo();
    await win.executeCommand('del C:\\ProgramData\\ssh\\ssh_host_ed25519_key.pub');
    await win.executeCommand('del C:\\ProgramData\\ssh\\ssh_host_ed25519_key');
    await win.executeCommand('ssh-keygen -A');
    const pub = await win.executeCommand('type C:\\ProgramData\\ssh\\ssh_host_ed25519_key.pub');
    expect(estUneCleDuFil(blobDe(pub))).toBe(true);
  });

  it('la cle que Windows genere SEUL porte le meme format', async () => {
    const { win } = await labo();
    const pub = await win.executeCommand('type C:\\ProgramData\\ssh\\ssh_host_ed25519_key.pub');
    expect(estUneCleDuFil(blobDe(pub))).toBe(true);
  });

  it('la cle que le serveur Linux genere SEUL porte le meme format', async () => {
    const { srv } = await labo();
    const pub = await srv.executeCommand('sudo cat /etc/ssh/ssh_host_ed25519_key.pub');
    expect(estUneCleDuFil(blobDe(pub))).toBe(true);
  });

  it('`ssh-keyscan` rend une cle du fil, pas autre chose', async () => {
    const { pc } = await labo();
    const ligne = await pc.executeCommand('ssh-keyscan 10.0.0.2');
    expect(estUneCleDuFil(blobDe(ligne))).toBe(true);
  });

  it('le known_hosts ecrit par une vraie connexion porte une cle du fil', async () => {
    const { pc } = await labo();
    await pc.executeCommand('sudo useradd -m alice');
    await pc.executeCommand('ssh -o StrictHostKeyChecking=accept-new alice@10.0.0.2 hostname');
    const kh = await pc.executeCommand('cat ~/.ssh/known_hosts');
    expect(estUneCleDuFil(blobDe(kh))).toBe(true);
  });

  it('l empreinte est le SHA-256 des 51 OCTETS, pas de leur base64', async () => {
    const { win } = await labo();
    const blob = blobDe(await win.executeCommand(
      'type C:\\ProgramData\\ssh\\ssh_host_ed25519_key.pub'));
    const octets = Uint8Array.from(atob(blob), c => c.charCodeAt(0));
    expect(octets.length).toBe(51);

    const empreinte = SshHostKey.fromFiles(blob, 'x').fingerprint.toString();
    expect(empreinte.startsWith('SHA256:')).toBe(true);
    expect(empreinte.slice('SHA256:'.length)).toHaveLength(43);

    const surLesOctets = `SHA256:${bytesToBase64(sha256(octets)).replace(/=+$/, '')}`;
    const surLeBase64 = `SHA256:${bytesToBase64(sha256(utf8ToBytes(blob))).replace(/=+$/, '')}`;
    expect(empreinte).toBe(surLesOctets);
    expect(empreinte).not.toBe(surLeBase64);
  });

  it('une machine ne presente pas DEUX cles differentes selon la vue', async () => {
    const { win, pc } = await labo();
    const surDisque = blobDe(await win.executeCommand(
      'type C:\\ProgramData\\ssh\\ssh_host_ed25519_key.pub'));
    const surLeFil = blobDe(await pc.executeCommand('ssh-keyscan 10.0.0.1'));
    expect(surLeFil).toBe(surDisque);
  });
});
