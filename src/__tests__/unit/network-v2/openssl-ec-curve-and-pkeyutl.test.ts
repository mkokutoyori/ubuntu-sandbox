/**
 * `openssl` cesse de se contredire sur les courbes, et `pkeyutl` signe
 * pour de vrai.
 *
 * Deux constats mesurés, tous deux conséquences du passage de la crypto
 * au réel.
 *
 * **Le défaut.** `ecparam -name secp384r1 -genkey` réussissait et
 * écrivait une clé **P-256** : `openssl ec -text` sur ce fichier
 * répondait `prime256v1` / `P-256`. Tant que la courbe n'était qu'une
 * étiquette, cela ne se voyait pas ; depuis qu'une clé EC porte un vrai
 * point sur une vraie courbe, rendre autre chose que ce qui est demandé
 * est un mensonge de la machine sur elle-même. Seule P-256 est
 * implémentée, et `-genkey` le dit désormais — avec le message de la
 * troisième famille d'options du PRD : openssl connaît cette courbe, ce
 * build ne l'implémente pas.
 *
 * **Ce qui était vrai sans être vérifié.** `pkeyutl -sign`/`-verify`
 * passe par `PkiKeyPair`, donc il est devenu réel en même temps que RSA
 * et ECDSA — mais rien ne le consommait, et le corollaire du
 * `PRD-OpenSSL` le rangeait justement parmi les commandes « dont
 * personne ne lit le produit ». Ces cas le lisent.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';

beforeEach(() => { EquipmentRegistry.getInstance().clear(); });

function machine(nom = 'EC'): LinuxServer {
  const srv = new LinuxServer('linux-server', nom);
  srv.powerOn();
  return srv;
}

describe('ecparam ne rend que la courbe demandée', () => {
  it('P-256 est fabriquée, et la clé se relit comme telle', async () => {
    const s = machine();
    await s.executeCommand('openssl ecparam -name prime256v1 -genkey -out /tmp/k.pem');

    expect(await s.executeCommand('cat /tmp/k.pem')).toContain('BEGIN EC PRIVATE KEY');
    const texte = await s.executeCommand('openssl ec -in /tmp/k.pem -noout -text');
    expect(texte).toContain('ASN1 OID: prime256v1');
    expect(texte).toContain('NIST CURVE: P-256');
  });

  it('P-384 est REFUSÉE au lieu de rendre une P-256 déguisée', async () => {
    const s = machine();
    const out = await s.executeCommand('openssl ecparam -name secp384r1 -genkey -out /tmp/k384.pem');

    expect(out).toContain('is not implemented in this simulator');
    // Et rien n'a été écrit : un refus qui laisserait un fichier serait
    // pire qu'un refus, puisque la suite du TP lirait cette clé.
    expect(await s.executeCommand('cat /tmp/k384.pem')).toContain('No such file');
  });

  it('P-521 aussi', async () => {
    const s = machine();
    expect(await s.executeCommand('openssl ecparam -name secp521r1 -genkey'))
      .toContain('is not implemented in this simulator');
  });

  it('une courbe inconnue reste une erreur d\'openssl, pas la nôtre', async () => {
    const s = machine();
    // La distinction du PRD : ce qu'openssl ne connaît pas et ce que ce
    // build n'implémente pas ne se disent pas de la même façon.
    expect(await s.executeCommand('openssl ecparam -name brainpoolP256r1 -genkey'))
      .toContain('unknown curve name');
  });

  it('DÉCRIRE une courbe non implémentée reste permis', async () => {
    const s = machine();
    // Nommer l'OID d'une courbe est un fait sur la courbe, pas une
    // prétention à savoir en fabriquer une clé.
    const out = await s.executeCommand('openssl ecparam -name secp384r1');
    expect(out).toContain('ASN1 OID: secp384r1');
    expect(out).toContain('NIST CURVE: P-384');
  });
});

describe('pkeyutl signe et vérifie réellement', () => {
  async function labRsa(): Promise<LinuxServer> {
    const s = machine();
    await s.executeCommand('openssl genrsa -out /tmp/k.pem 512');
    await s.executeCommand(`sh -c 'echo "le message" > /tmp/m.txt'`);
    await s.executeCommand('openssl pkeyutl -sign -in /tmp/m.txt -inkey /tmp/k.pem -out /tmp/m.sig');
    return s;
  }

  it('la bonne signature du bon message est acceptée', async () => {
    const s = await labRsa();
    expect(await s.executeCommand(
      'openssl pkeyutl -verify -in /tmp/m.txt -inkey /tmp/k.pem -sigfile /tmp/m.sig'))
      .toContain('Signature Verified Successfully');
  });

  it('un autre message est refusé', async () => {
    const s = await labRsa();
    await s.executeCommand(`sh -c 'echo "un autre" > /tmp/autre.txt'`);
    expect(await s.executeCommand(
      'openssl pkeyutl -verify -in /tmp/autre.txt -inkey /tmp/k.pem -sigfile /tmp/m.sig'))
      .toContain('Signature Verification Failure');
  });

  it('et le code de sortie distingue les deux', async () => {
    const s = await labRsa();
    await s.executeCommand(`sh -c 'echo "un autre" > /tmp/autre.txt'`);
    expect((await s.executeCommand(
      'sh -c \'openssl pkeyutl -verify -in /tmp/m.txt -inkey /tmp/k.pem -sigfile /tmp/m.sig >/dev/null 2>&1; echo $?\'',
    )).trim()).toBe('0');
    expect((await s.executeCommand(
      'sh -c \'openssl pkeyutl -verify -in /tmp/autre.txt -inkey /tmp/k.pem -sigfile /tmp/m.sig >/dev/null 2>&1; echo $?\'',
    )).trim()).toBe('1');
  });

  it('une autre clé est refusée', async () => {
    const s = await labRsa();
    await s.executeCommand('openssl genrsa -out /tmp/autre.pem 512');
    expect(await s.executeCommand(
      'openssl pkeyutl -verify -in /tmp/m.txt -inkey /tmp/autre.pem -sigfile /tmp/m.sig'))
      .toContain('Signature Verification Failure');
  });

  it('la vérification marche avec la seule clé PUBLIQUE', async () => {
    const s = await labRsa();
    await s.executeCommand('openssl rsa -in /tmp/k.pem -pubout -out /tmp/k.pub');
    // C'est le point qui distingue une vraie signature d'un condensé : la
    // moitié publique suffit à vérifier, et ne permet pas de signer.
    expect(await s.executeCommand(
      'openssl pkeyutl -verify -in /tmp/m.txt -inkey /tmp/k.pub -sigfile /tmp/m.sig'))
      .toContain('Signature Verified Successfully');
  });

  it('et une clé EC signe aussi bien qu\'une clé RSA', async () => {
    const s = machine();
    await s.executeCommand('openssl ecparam -name prime256v1 -genkey -out /tmp/ec.pem');
    await s.executeCommand(`sh -c 'echo "message ec" > /tmp/m.txt'`);
    await s.executeCommand('openssl pkeyutl -sign -in /tmp/m.txt -inkey /tmp/ec.pem -out /tmp/ec.sig');

    expect(await s.executeCommand(
      'openssl pkeyutl -verify -in /tmp/m.txt -inkey /tmp/ec.pem -sigfile /tmp/ec.sig'))
      .toContain('Signature Verified Successfully');
    await s.executeCommand(`sh -c 'echo "modifie" > /tmp/m2.txt'`);
    expect(await s.executeCommand(
      'openssl pkeyutl -verify -in /tmp/m2.txt -inkey /tmp/ec.pem -sigfile /tmp/ec.sig'))
      .toContain('Signature Verification Failure');
  });
});
