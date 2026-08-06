/**
 * Une CRL publiée est opposable, et signée par qui la publie.
 *
 * Le défaut mesuré : `openssl ca -gencrl` écrivait un OBJET QUELCONQUE —
 * un émetteur, deux dates, une liste de séries — sans version, sans
 * algorithme et surtout SANS SIGNATURE, alors que `CertificateRevocationList`
 * existait depuis toujours avec son `sign`/`isValidSignature`/`contains`.
 * `pemToCrl` rendait `unknown`, si bien qu'aucun appelant ne pouvait rien
 * en demander : la liste ne servait qu'à être réaffichée.
 *
 * Conséquence concrète, celle qui compte pour un TP : révoquer un
 * certificat ne changeait rien pour personne. `openssl verify` l'acceptait
 * toujours, et il n'existait aucune commande capable de dire le contraire.
 *
 * `-gencrl` signe désormais avec la clé de la CA — la même qui a signé les
 * certificats qu'elle révoque — et `openssl verify -crl_check -CRLfile`
 * la consulte réellement. C'est ce consommateur qui rend la CRL vraie ;
 * sans lui elle resterait un fichier que rien ne peut contredire.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';

beforeEach(() => { EquipmentRegistry.getInstance().clear(); });

/** Une autorité, un certificat émis par elle, sa série retenue. */
async function autorite(nom: string): Promise<{ srv: LinuxServer; serie: string }> {
  const srv = new LinuxServer('linux-server', nom);
  srv.powerOn();
  await srv.executeCommand('mkdir -p /etc/ssl/CA');
  await srv.executeCommand(
    'openssl req -x509 -newkey rsa:2048 -keyout /etc/ssl/CA/ca.key '
    + '-out /etc/ssl/CA/ca.crt -days 365 -nodes -subj "/CN=Lab Root CA"');
  await srv.executeCommand('openssl genrsa -out /tmp/w.key 2048');
  await srv.executeCommand(
    'openssl req -new -key /tmp/w.key -out /tmp/w.csr -subj "/CN=www.lab"');
  await srv.executeCommand(
    'openssl ca -cert /etc/ssl/CA/ca.crt -keyfile /etc/ssl/CA/ca.key '
    + '-in /tmp/w.csr -out /tmp/w.crt -days 90');
  const serie = (await srv.executeCommand('openssl x509 -in /tmp/w.crt -noout -serial'))
    .trim().replace('serial=', '');
  return { srv, serie };
}

async function publierCrl(srv: LinuxServer, chemin: string): Promise<void> {
  await srv.executeCommand(
    'openssl ca -cert /etc/ssl/CA/ca.crt -keyfile /etc/ssl/CA/ca.key '
    + `-gencrl -out ${chemin}`);
}

describe('révoquer a un effet', () => {
  it('avant révocation, le certificat passe le contrôle de CRL', async () => {
    const { srv } = await autorite('C1');
    await publierCrl(srv, '/tmp/lab.crl');

    // La référence : sans elle, le refus ci-dessous pourrait n'être qu'un
    // `-crl_check` qui refuse tout.
    expect(await srv.executeCommand(
      'openssl verify -crl_check -CAfile /etc/ssl/CA/ca.crt -CRLfile /tmp/lab.crl /tmp/w.crt'))
      .toContain('/tmp/w.crt: OK');
  });

  it('après révocation et republication, il est refusé', async () => {
    const { srv } = await autorite('C2');
    await srv.executeCommand(
      'openssl ca -cert /etc/ssl/CA/ca.crt -keyfile /etc/ssl/CA/ca.key -revoke /tmp/w.crt');
    await publierCrl(srv, '/tmp/lab.crl');

    const out = await srv.executeCommand(
      'openssl verify -crl_check -CAfile /etc/ssl/CA/ca.crt -CRLfile /tmp/lab.crl /tmp/w.crt');
    expect(out).not.toContain('OK');
    expect(out).toContain('error 23 at 0 depth lookup: certificate revoked');
  });

  it('sans -crl_check, la CRL ne s\'invite pas : openssl ne la consulte que si on le demande', async () => {
    const { srv } = await autorite('C3');
    await srv.executeCommand(
      'openssl ca -cert /etc/ssl/CA/ca.crt -keyfile /etc/ssl/CA/ca.key -revoke /tmp/w.crt');
    await publierCrl(srv, '/tmp/lab.crl');

    expect(await srv.executeCommand('openssl verify -CAfile /etc/ssl/CA/ca.crt /tmp/w.crt'))
      .toContain('/tmp/w.crt: OK');
  });

  it('-crl_check sans liste refuse plutôt que de laisser passer', async () => {
    const { srv } = await autorite('C4');

    // Une révocation qu'on ne peut pas vérifier n'est pas une absence de
    // révocation. 3 = unable to get certificate CRL.
    const out = await srv.executeCommand(
      'openssl verify -crl_check -CAfile /etc/ssl/CA/ca.crt /tmp/w.crt');
    expect(out).toContain('error 3 at 0 depth lookup: unable to get certificate CRL');
  });
});

describe('la liste porte la signature de son autorité', () => {
  it('une CRL fabriquée par une autre CA du même nom est refusée', async () => {
    const { srv } = await autorite('C5');
    await srv.executeCommand(
      'openssl ca -cert /etc/ssl/CA/ca.crt -keyfile /etc/ssl/CA/ca.key -revoke /tmp/w.crt');
    await publierCrl(srv, '/tmp/vraie.crl');

    // Une autorité homonyme, avec son propre index, publie sa propre
    // liste. Elle porte le même nom d'émetteur ; seule la signature les
    // sépare — et c'est précisément ce qui n'existait pas.
    await srv.executeCommand('mkdir -p /tmp/rogue');
    await srv.executeCommand(
      'openssl req -x509 -newkey rsa:2048 -keyout /tmp/rogue/ca.key '
      + '-out /tmp/rogue/ca.crt -days 365 -nodes -subj "/CN=Lab Root CA"');
    await srv.executeCommand(
      'openssl ca -cert /tmp/rogue/ca.crt -keyfile /tmp/rogue/ca.key -gencrl -out /tmp/fausse.crl');

    const out = await srv.executeCommand(
      'openssl verify -crl_check -CAfile /etc/ssl/CA/ca.crt -CRLfile /tmp/fausse.crl /tmp/w.crt');
    // 8 = CRL signature failure. Sans ce refus, n'importe qui pourrait
    // publier une liste VIDE et faire réapparaître un certificat révoqué.
    expect(out).toContain('error 8 at 0 depth lookup: CRL signature failure');
  });

  it('et la vraie liste, elle, est acceptée — les deux ne sont pas refusées pareil', async () => {
    const { srv } = await autorite('C6');
    await publierCrl(srv, '/tmp/vraie.crl');

    expect(await srv.executeCommand(
      'openssl verify -crl_check -CAfile /etc/ssl/CA/ca.crt -CRLfile /tmp/vraie.crl /tmp/w.crt'))
      .toContain('/tmp/w.crt: OK');
  });
});

describe('ce que la liste affiche vient de ce qu\'elle contient', () => {
  it('la série révoquée y figure', async () => {
    const { srv, serie } = await autorite('C7');
    await srv.executeCommand(
      'openssl ca -cert /etc/ssl/CA/ca.crt -keyfile /etc/ssl/CA/ca.key -revoke /tmp/w.crt');
    await publierCrl(srv, '/tmp/lab.crl');

    const texte = await srv.executeCommand('openssl crl -in /tmp/lab.crl -noout -text');
    expect(texte).toContain('Revoked Certificates:');
    expect(texte).toContain(serie);
  });

  it('et sa date de révocation s\'écrit comme toutes les dates d\'openssl', async () => {
    const { srv } = await autorite('C8');
    await srv.executeCommand(
      'openssl ca -cert /etc/ssl/CA/ca.crt -keyfile /etc/ssl/CA/ca.key -revoke /tmp/w.crt');
    await publierCrl(srv, '/tmp/lab.crl');

    // Elle sortait au format interne de l'index (`260806083012Z`), qui
    // n'apparaît nulle part ailleurs dans openssl.
    expect(await srv.executeCommand('openssl crl -in /tmp/lab.crl -noout -text'))
      .toMatch(/Revocation Date: [A-Z][a-z]{2} [ \d]\d \d{2}:\d{2}:\d{2} \d{4} GMT/);
  });

  it('une liste vide le dit encore', async () => {
    const { srv } = await autorite('C9');
    await publierCrl(srv, '/tmp/vide.crl');

    expect(await srv.executeCommand('openssl crl -in /tmp/vide.crl -noout -text'))
      .toContain('No Revoked Certificates.');
  });
});
