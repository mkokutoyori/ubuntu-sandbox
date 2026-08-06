/**
 * `openssl pkcs8` chiffre pour de vrai — et `-nocrypt` redevient ce
 * qu'il est : la demande explicite de NE PAS chiffrer.
 *
 * Le défaut : `-topk8` rendait toujours une clé EN CLAIR, `-nocrypt`
 * n'était même pas lu, et l'étiquette `ENCRYPTED PRIVATE KEY` — présente
 * dans `PemLabel` depuis toujours — n'était écrite par personne. Un TP y
 * apprenait donc l'inverse de ce que la commande enseigne : que protéger
 * une clé privée par une phrase de passe est le défaut, et le clair
 * l'exception.
 *
 * C'était le dernier des trois sous-modes que le corollaire du
 * `PRD-OpenSSL` rangeait parmi ceux « dont personne ne lit le produit »,
 * avec `crl` et `pkeyutl`.
 *
 * Le chiffrement est RÉEL : AES-256-CBC sur une clé dérivée par PBKDF2,
 * les deux déjà éprouvés dans `src/crypto/` et déjà servis par
 * `openssl enc`. Ce que les cas ci-dessous mesurent n'est donc pas la
 * force du chiffrement mais son EFFET : la clé n'est plus lisible sans
 * la phrase, et elle redevient exactement elle-même avec.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';

beforeEach(() => { EquipmentRegistry.getInstance().clear(); });

async function machineAvecCle(nom = 'P8'): Promise<LinuxServer> {
  const srv = new LinuxServer('linux-server', nom);
  srv.powerOn();
  await srv.executeCommand('openssl genrsa -out /tmp/k.pem 512');
  return srv;
}

describe('-topk8 chiffre, sauf si on demande le contraire', () => {
  it('avec une phrase de passe, la clé sort en ENCRYPTED PRIVATE KEY', async () => {
    const s = await machineAvecCle();
    await s.executeCommand(
      'openssl pkcs8 -topk8 -in /tmp/k.pem -out /tmp/k8.pem -passout pass:secret');

    const pem = await s.executeCommand('cat /tmp/k8.pem');
    expect(pem).toContain('BEGIN ENCRYPTED PRIVATE KEY');
    expect(pem).not.toContain('BEGIN PRIVATE KEY');
  });

  it('et le matériel de la clé n\'est plus dans le fichier, base64 DÉCODÉ', async () => {
    const s = await machineAvecCle();
    const module = (await s.executeCommand('openssl rsa -in /tmp/k.pem -noout -modulus'))
      .trim().replace('Modulus=', '');
    expect(module.length).toBeGreaterThan(20);

    // La référence, et elle est indispensable : une armure est du base64
    // dans les deux cas, donc « le module n'apparaît pas dans le
    // fichier » ne prouve rien tant qu'on n'a pas DÉCODÉ. En clair, il
    // est bien là.
    await s.executeCommand('openssl pkcs8 -topk8 -nocrypt -in /tmp/k.pem -out /tmp/clair.pem');
    const decode = (pem: string): string => {
      const corps = pem.replace(/-----[^-]+-----/g, '').replace(/\s+/g, '');
      return Buffer.from(corps, 'base64').toString('utf8');
    };
    expect(decode(await s.executeCommand('cat /tmp/clair.pem')).toUpperCase())
      .toContain(module.slice(0, 20));

    // Chiffré, il ne l'est plus.
    await s.executeCommand(
      'openssl pkcs8 -topk8 -in /tmp/k.pem -out /tmp/k8.pem -passout pass:secret');
    expect(decode(await s.executeCommand('cat /tmp/k8.pem')).toUpperCase())
      .not.toContain(module.slice(0, 20));
  });

  it('`-nocrypt` demande le clair, et l\'obtient', async () => {
    const s = await machineAvecCle();
    await s.executeCommand(
      'openssl pkcs8 -topk8 -nocrypt -in /tmp/k.pem -out /tmp/k8.pem');

    const pem = await s.executeCommand('cat /tmp/k8.pem');
    expect(pem).toContain('BEGIN PRIVATE KEY');
    expect(pem).not.toContain('ENCRYPTED');
  });

  it('sans phrase ni -nocrypt, la commande REFUSE au lieu de rendre du clair', async () => {
    const s = await machineAvecCle();
    const out = await s.executeCommand('openssl pkcs8 -topk8 -in /tmp/k.pem -out /tmp/k8.pem');

    expect(out).toContain('unable to write key');
    // Et rien n'est écrit : un refus qui laisserait une clé en clair
    // derrière lui serait exactement le défaut qu'on corrige.
    expect(await s.executeCommand('cat /tmp/k8.pem')).toContain('No such file');
  });
});

describe('relire une clé chiffrée', () => {
  async function labChiffre(): Promise<LinuxServer> {
    const s = await machineAvecCle();
    await s.executeCommand(
      'openssl pkcs8 -topk8 -in /tmp/k.pem -out /tmp/k8.pem -passout pass:secret');
    return s;
  }

  it('la bonne phrase rend EXACTEMENT la clé de départ', async () => {
    const s = await labChiffre();
    const avant = await s.executeCommand('openssl rsa -in /tmp/k.pem -noout -modulus');

    await s.executeCommand(
      'openssl pkcs8 -in /tmp/k8.pem -passin pass:secret -out /tmp/rendu.pem');
    const apres = await s.executeCommand('openssl rsa -in /tmp/rendu.pem -noout -modulus');

    // Le module est l'identité de la clé : s'il est le même, c'est la
    // même clé, pas une clé équivalente.
    expect(apres.trim()).toBe(avant.trim());
  });

  it('la mauvaise phrase échoue, sans rendre une autre clé', async () => {
    const s = await labChiffre();
    const out = await s.executeCommand(
      'openssl pkcs8 -in /tmp/k8.pem -passin pass:mauvaise -out /tmp/rendu.pem');

    expect(out).toContain('bad decrypt');
    expect(await s.executeCommand('cat /tmp/rendu.pem')).toContain('No such file');
  });

  it('sans phrase du tout, la commande le dit au lieu d\'échouer sur la forme', async () => {
    const s = await labChiffre();
    const out = await s.executeCommand('openssl pkcs8 -in /tmp/k8.pem -out /tmp/rendu.pem');
    expect(out).toContain('unable to load key');
    expect(out).toContain('-passin');
  });

  it('et la clé chiffrée n\'est pas lisible par les commandes ordinaires', async () => {
    const s = await labChiffre();
    // `openssl rsa -in` ne connaît pas la phrase : il ne doit pas rendre
    // la clé, sans quoi le chiffrement ne protégerait rien.
    expect(await s.executeCommand('openssl rsa -in /tmp/k8.pem -noout -modulus'))
      .toContain('unable to load Private Key');
  });
});

describe('un aller-retour complet', () => {
  it('clair → chiffré → clair, et la clé signe toujours pareil', async () => {
    const s = await machineAvecCle();
    await s.executeCommand(`sh -c 'echo "message" > /tmp/m.txt'`);
    await s.executeCommand('openssl pkeyutl -sign -in /tmp/m.txt -inkey /tmp/k.pem -out /tmp/m.sig');

    await s.executeCommand(
      'openssl pkcs8 -topk8 -in /tmp/k.pem -out /tmp/k8.pem -passout pass:secret');
    await s.executeCommand(
      'openssl pkcs8 -in /tmp/k8.pem -passin pass:secret -out /tmp/rendu.pem');

    // La preuve que le tour de chiffrement n'a rien perdu : la signature
    // faite AVANT se vérifie avec la clé rendue APRÈS.
    expect(await s.executeCommand(
      'openssl pkeyutl -verify -in /tmp/m.txt -inkey /tmp/rendu.pem -sigfile /tmp/m.sig'))
      .toContain('Signature Verified Successfully');
  });

  it('une clé EC passe le même aller-retour', async () => {
    const s = new LinuxServer('linux-server', 'P8EC');
    s.powerOn();
    await s.executeCommand('openssl ecparam -name prime256v1 -genkey -out /tmp/ec.pem');
    await s.executeCommand(`sh -c 'echo "message ec" > /tmp/m.txt'`);
    await s.executeCommand('openssl pkeyutl -sign -in /tmp/m.txt -inkey /tmp/ec.pem -out /tmp/m.sig');

    await s.executeCommand(
      'openssl pkcs8 -topk8 -in /tmp/ec.pem -out /tmp/ec8.pem -passout pass:s3cr3t');
    await s.executeCommand(
      'openssl pkcs8 -in /tmp/ec8.pem -passin pass:s3cr3t -out /tmp/ecrendu.pem');

    expect(await s.executeCommand(
      'openssl pkeyutl -verify -in /tmp/m.txt -inkey /tmp/ecrendu.pem -sigfile /tmp/m.sig'))
      .toContain('Signature Verified Successfully');
  });

  it('deux chiffrements de la même clé ne donnent pas le même fichier', async () => {
    const s = await machineAvecCle();
    await s.executeCommand(
      'openssl pkcs8 -topk8 -in /tmp/k.pem -out /tmp/a.pem -passout pass:secret');
    await s.executeCommand(
      'openssl pkcs8 -topk8 -in /tmp/k.pem -out /tmp/b.pem -passout pass:secret');

    // Sel et IV tirés à chaque fois : deux armures identiques
    // signaleraient un chiffrement déterministe, donc sans sel.
    const a = await s.executeCommand('cat /tmp/a.pem');
    const b = await s.executeCommand('cat /tmp/b.pem');
    expect(a).not.toBe(b);

    // Et les deux se déchiffrent quand même avec la même phrase.
    await s.executeCommand('openssl pkcs8 -in /tmp/b.pem -passin pass:secret -out /tmp/rb.pem');
    expect(await s.executeCommand('openssl rsa -in /tmp/rb.pem -noout -modulus'))
      .toContain('Modulus=');
  });
});
