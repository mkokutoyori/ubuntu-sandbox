/**
 * Une adresse LITTERALE ne « ne se resout pas » : elle se scanne, ou elle
 * ne se joint pas (BRD-Modele-TCP-IP.md phase 8, lot 8).
 *
 * ── Ce que la mesure a trouve ───────────────────────────────────────
 *
 * Depuis un hote en 10.0.0.1/24 :
 *
 *   nmap -p 22 10.0.0.55   ->  Failed to resolve "10.0.0.55".
 *                              Nmap done: 0 IP addresses (0 hosts up)
 *   telnet 203.0.113.9     ->  telnet: could not resolve 203.0.113.9/23:
 *                              Name or service not known
 *
 * Ce sont des quadruplets pointes : il n'y a RIEN a resoudre. Le
 * diagnostic envoie verifier le DNS quand le probleme est le routage, et
 * c'est la confusion la plus couteuse apres celle du delai.
 *
 * La cause est commune aux deux commandes : la cible est cherchee dans la
 * TOPOLOGIE, et « pas trouvee » est traduit par « pas resolue ».
 *
 * ── Ce que fait la vraie machine ────────────────────────────────────
 *
 * nmap SCANNE une adresse litterale que personne ne porte, et la rapporte
 * en panne. `output.cc:2500` porte la condition et le texte :
 *
 *     if (o.numhosts_scanned == 1 && o.numhosts_up == 0 && !o.listscan &&
 *         o.pingtype != PINGTYPE_NONE)
 *       log_write(LOG_STDOUT, "Note: Host seems down. If it is really up,
 *                 but blocking our ping probes, try -Pn\n");
 *
 * — donc l'hote est COMPTE comme scanne (`numhosts_scanned == 1`), ce que
 * le decompte final doit dire. Le mot « Failed to resolve » est reserve
 * dans nmap aux noms qu'aucune resolution ne rend.
 *
 * Cote telnet, l'echec est celui de la connexion, et son texte est celui
 * de l'errno : ENETUNREACH (101) `Network is unreachable` quand aucune
 * route ne dessert la destination, EHOSTUNREACH (113) `No route to host`
 * quand une route existe et que personne ne repond. La regle est celle
 * que `sshUnreachableReason` porte deja depuis le lot 6 — elle est LUE,
 * pas recopiee.
 *
 * ── Discrimination ─────────────────────────────────────────────────
 *
 * QUATRE cas sur six tombent. Les deux autres sont les TEMOINS des NOMS,
 * un par commande, et ils passent des deux cotes comme ils le doivent :
 * un nom qu'aucune resolution ne rend DOIT continuer de dire qu'il ne se
 * resout pas, et sans eux un correctif qui supprimerait ce message
 * passerait cette sonde.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { GenericSwitch } from '@/network/devices/GenericSwitch';
import { Cable } from '@/network/hardware/Cable';
import { resetCounters, MACAddress, IPAddress, SubnetMask } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  MACAddress.resetCounter();
  Logger.reset();
});

async function poste() {
  const pc = new LinuxPC('pc1');
  const sw = new GenericSwitch('switch-generic', 'SW');
  new Cable('c1').connect(pc.getPorts()[0], sw.getPorts()[0]);
  pc.getPorts()[0].configureIP(new IPAddress('10.0.0.1'), new SubnetMask('255.255.255.0'));
  return pc;
}

describe('une adresse litterale n\'est pas une panne de DNS', () => {
  it('nmap SCANNE une adresse que personne ne porte, et la compte', async () => {
    const sortie = await (await poste()).executeCommand('nmap -p 22 10.0.0.55');
    expect(sortie).not.toContain('Failed to resolve');
    expect(sortie).toContain('Nmap done: 1 IP address (0 hosts up)');
  });

  it('nmap rend la note de nmap pour un hote en panne', async () => {
    const sortie = await (await poste()).executeCommand('nmap -p 22 10.0.0.55');
    expect(sortie).toContain(
      'Note: Host seems down. If it is really up, but blocking our ping probes, try -Pn');
  });

  it('telnet vers une adresse SANS ROUTE rend ENETUNREACH', async () => {
    const sortie = await (await poste()).executeCommand('telnet 203.0.113.9');
    expect(sortie).toContain('telnet: connect to address 203.0.113.9: Network is unreachable');
    expect(sortie).not.toContain('could not resolve');
  });

  it('telnet vers une adresse SUR LE LIEN que personne ne porte rend EHOSTUNREACH', async () => {
    const sortie = await (await poste()).executeCommand('telnet 10.0.0.55');
    expect(sortie).toContain('telnet: connect to address 10.0.0.55: No route to host');
    expect(sortie).not.toContain('could not resolve');
  });

  it('TEMOIN : un NOM qui ne se resout pas le dit encore, sous nmap', async () => {
    const sortie = await (await poste()).executeCommand('nmap -p 22 zorglub.invalid');
    expect(sortie).toContain('Failed to resolve "zorglub.invalid".');
  });

  it('TEMOIN : un NOM qui ne se resout pas le dit encore, sous telnet', async () => {
    const sortie = await (await poste()).executeCommand('telnet zorglub.invalid');
    expect(sortie).toContain('Name or service not known');
  });
});
