/**
 * Sonde — une charge utile BINAIRE traverse un routeur comme une charge
 * texte : segmentee par la MSS, remontee entiere a l'application.
 *
 * Mesure d'origine (`TcpStack._sendData`) : une charge qui n'etait pas une
 * `string` partait en UN seul segment non decoupe, quelle que soit sa
 * taille. Sur un lien direct la trame surdimensionnee etait remise quand
 * meme ; des qu'un routeur etait sur le chemin, elle depassait la MTU de
 * l'interface de sortie et disparaissait sans erreur. La promotion d'un
 * second controleur de domaine sur un autre site echouait ainsi sur
 * « Initial synchronization ... failed: no reply from replication
 * partner », parce que la reponse de replication (15505 octets de JSON
 * encode en `Uint8Array`) ne franchissait jamais le premier routeur.
 *
 * Discrimination `git stash` : 4 cas tombent avant le correctif —
 * « remet des octets au-dela de la MTU », « ne laisse aucune trame
 * depasser la MTU », « remonte la charge volumineuse en une seule fois »
 * et « synchronise DC02 place sur un autre site ». Le cas des trames
 * compte les octets REELLEMENT achemines sur la dorsale en plus de
 * borner leur taille : borner seul passerait a vide avant le correctif,
 * ou le paquet surdimensionne est jete et ne laisse que des acquittements
 * derriere lui.
 *
 * Passent des deux cotes, et pourquoi :
 *  - « texte au-dela de la MTU » — NON-REGRESSION : le chemin texte
 *    decoupait deja par MSS, il doit continuer.
 *  - « octets sous la MTU » — NON-REGRESSION : un seul segment suffisait
 *    deja, rien ne change.
 *  - « octets au-dela de la MTU sur un lien direct » — TEMOIN : prouve que
 *    le laboratoire lui-meme transporte bien 15505 octets, donc qu'un
 *    echec sur le chemin route accuse le routage et non la charge.
 *  - « un objet opaque reste remis tel quel » — STRUCTUREL : une charge
 *    qui n'est ni texte ni octets n'est pas un flux, elle occupe une unite
 *    de sequence et arrive verbatim, avant comme apres.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { WindowsServer } from '@/network/devices/WindowsServer';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { GenericSwitch } from '@/network/devices/GenericSwitch';
import { Cable } from '@/network/hardware/Cable';
import { IPAddress, SubnetMask, MACAddress, resetCounters } from '@/network/core/types';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { PowerShellSubShell } from '@/terminal/subshells/PowerShellSubShell';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  MACAddress.resetCounter();
  EquipmentRegistry.resetInstance();
  Logger.reset();
});

const M30 = new SubnetMask('255.255.255.252');
const M24 = new SubnetMask('255.255.255.0');
const AU_DELA_DE_LA_MTU = 15505;

interface Achemine {
  a: LinuxPC;
  b: LinuxPC;
  liaison: { longueurs(): number[] };
}

async function cheminRoute(): Promise<Achemine> {
  const a = new LinuxPC('linux-pc', 'A');
  const b = new LinuxPC('linux-pc', 'B');
  const r1 = new CiscoRouter('R1', 0, 0);
  const r2 = new CiscoRouter('R2', 0, 0);
  for (const d of [a, b, r1, r2]) d.powerOn();
  new Cable('acces-a').connect(a.getPorts()[0], r1.getPort('GigabitEthernet0/0')!);
  new Cable('dorsale').connect(r1.getPort('GigabitEthernet0/1')!, r2.getPort('GigabitEthernet0/1')!);
  new Cable('acces-b').connect(b.getPorts()[0], r2.getPort('GigabitEthernet0/0')!);
  a.getPorts()[0].configureIP(new IPAddress('192.168.1.2'), M30);
  b.getPorts()[0].configureIP(new IPAddress('192.168.2.2'), M30);
  a.setDefaultGateway(new IPAddress('192.168.1.1'));
  b.setDefaultGateway(new IPAddress('192.168.2.1'));
  for (const c of [
    'enable', 'configure terminal',
    'interface GigabitEthernet0/0', 'ip address 192.168.1.1 255.255.255.252', 'no shutdown', 'exit',
    'interface GigabitEthernet0/1', 'ip address 10.0.0.1 255.255.255.252', 'no shutdown', 'exit',
    'ip route 192.168.2.0 255.255.255.252 10.0.0.2', 'end',
  ]) await r1.executeCommand(c);
  for (const c of [
    'enable', 'configure terminal',
    'interface GigabitEthernet0/0', 'ip address 192.168.2.1 255.255.255.252', 'no shutdown', 'exit',
    'interface GigabitEthernet0/1', 'ip address 10.0.0.2 255.255.255.252', 'no shutdown', 'exit',
    'ip route 192.168.1.0 255.255.255.252 10.0.0.1', 'end',
  ]) await r2.executeCommand(c);

  const longueurs: number[] = [];
  const dorsale = r1.getPort('GigabitEthernet0/1')!;
  dorsale.attachTap(({ direction, frame }) => {
    if (direction !== 'out') return;
    const paquet = frame.payload as { totalLength?: number } | undefined;
    if (paquet && typeof paquet.totalLength === 'number') longueurs.push(paquet.totalLength);
  });
  return { a, b, liaison: { longueurs: () => longueurs } };
}

function echange(a: LinuxPC, b: LinuxPC, destination: string, charge: unknown, port: number): unknown[] {
  const recu: unknown[] = [];
  b.getTcpStack().listen(port, { onAccept: (sock) => { sock.onData((d) => { recu.push(d); }); } });
  const s = a.getTcpStack().connect(destination, port);
  expect(s?.state).toBe('established');
  s!.send(charge);
  return recu;
}

describe('Sonde — une charge binaire est un flux TCP comme un autre', () => {
  it('remet des octets au-dela de la MTU a travers deux routeurs', async () => {
    const { a, b } = await cheminRoute();
    const charge = new Uint8Array(AU_DELA_DE_LA_MTU).fill(0x41);
    const recu = echange(a, b, '192.168.2.2', charge, 9201);
    const octets = recu.filter((c): c is Uint8Array => c instanceof Uint8Array);
    expect(octets.reduce((n, c) => n + c.length, 0)).toBe(AU_DELA_DE_LA_MTU);
  });

  it('ne laisse aucune trame depasser la MTU de la dorsale', async () => {
    const { a, b, liaison } = await cheminRoute();
    echange(a, b, '192.168.2.2', new Uint8Array(AU_DELA_DE_LA_MTU).fill(0x41), 9202);
    const longueurs = liaison.longueurs();
    expect(longueurs.reduce((n, l) => n + l, 0)).toBeGreaterThanOrEqual(AU_DELA_DE_LA_MTU);
    expect(Math.max(...longueurs)).toBeLessThanOrEqual(1500);
  });

  it('remonte la charge volumineuse en une seule fois a l application', async () => {
    const { a, b } = await cheminRoute();
    const recu = echange(a, b, '192.168.2.2', new Uint8Array(AU_DELA_DE_LA_MTU).fill(0x41), 9203);
    expect(recu).toHaveLength(1);
    expect((recu[0] as Uint8Array).length).toBe(AU_DELA_DE_LA_MTU);
  });

  it('remet du texte au-dela de la MTU a travers deux routeurs', async () => {
    const { a, b } = await cheminRoute();
    const recu = echange(a, b, '192.168.2.2', 'x'.repeat(AU_DELA_DE_LA_MTU), 9204);
    expect(recu.join('')).toHaveLength(AU_DELA_DE_LA_MTU);
  });

  it('remet des octets sous la MTU a travers deux routeurs', async () => {
    const { a, b } = await cheminRoute();
    const recu = echange(a, b, '192.168.2.2', new Uint8Array(1000).fill(0x41), 9205);
    expect((recu[0] as Uint8Array).length).toBe(1000);
  });

  it('remet des octets au-dela de la MTU sur un lien direct', () => {
    const a = new LinuxPC('linux-pc', 'A');
    const b = new LinuxPC('linux-pc', 'B');
    a.powerOn(); b.powerOn();
    new Cable('direct').connect(a.getPorts()[0], b.getPorts()[0]);
    a.getPorts()[0].configureIP(new IPAddress('192.168.1.2'), M30);
    b.getPorts()[0].configureIP(new IPAddress('192.168.1.1'), M30);
    const recu = echange(a, b, '192.168.1.1', new Uint8Array(AU_DELA_DE_LA_MTU).fill(0x41), 9206);
    expect((recu[0] as Uint8Array).length).toBe(AU_DELA_DE_LA_MTU);
  });

  it('remet un objet opaque tel quel', async () => {
    const { a, b } = await cheminRoute();
    const objet = { kind: 'opaque', valeur: 42 };
    const recu = echange(a, b, '192.168.2.2', objet, 9207);
    expect(recu).toEqual([objet]);
  });
});

describe('Sonde — un second controleur de domaine replique a travers un chemin route', () => {
  it('synchronise DC02 depuis DC01 place sur un autre site', async () => {
    const dc1 = new WindowsServer('DC01');
    const dc2 = new WindowsServer('DC02');
    const swHq = new GenericSwitch('switch-generic', 'SW-HQ', 8, 0, 0);
    const swBr = new GenericSwitch('switch-generic', 'SW-BR', 8, 0, 0);
    const rHq = new CiscoRouter('R-HQ', 0, 0);
    const rBr = new CiscoRouter('R-BR', 0, 0);
    for (const d of [dc1, dc2, swHq, swBr, rHq, rBr]) d.powerOn();
    new Cable('hq-dc').connect(dc1.getPorts()[0], swHq.getPorts()[0]);
    new Cable('hq-gw').connect(rHq.getPort('GigabitEthernet0/0')!, swHq.getPorts()[7]);
    new Cable('dorsale').connect(rHq.getPort('GigabitEthernet0/1')!, rBr.getPort('GigabitEthernet0/1')!);
    new Cable('br-gw').connect(rBr.getPort('GigabitEthernet0/0')!, swBr.getPorts()[7]);
    new Cable('br-dc').connect(dc2.getPorts()[0], swBr.getPorts()[0]);
    dc1.getPorts()[0].configureIP(new IPAddress('192.168.10.10'), M24);
    dc2.getPorts()[0].configureIP(new IPAddress('192.168.20.10'), M24);
    dc1.setDefaultGateway(new IPAddress('192.168.10.1'));
    dc2.setDefaultGateway(new IPAddress('192.168.20.1'));
    for (const c of [
      'enable', 'configure terminal',
      'interface GigabitEthernet0/0', 'ip address 192.168.10.1 255.255.255.0', 'no shutdown', 'exit',
      'interface GigabitEthernet0/1', 'ip address 10.0.0.1 255.255.255.252', 'no shutdown', 'exit',
      'ip route 192.168.20.0 255.255.255.0 10.0.0.2', 'end',
    ]) await rHq.executeCommand(c);
    for (const c of [
      'enable', 'configure terminal',
      'interface GigabitEthernet0/0', 'ip address 192.168.20.1 255.255.255.0', 'no shutdown', 'exit',
      'interface GigabitEthernet0/1', 'ip address 10.0.0.2 255.255.255.252', 'no shutdown', 'exit',
      'ip route 192.168.10.0 255.255.255.0 10.0.0.1', 'end',
    ]) await rBr.executeCommand(c);

    const ps = (d: WindowsServer) => PowerShellSubShell.create(d).subShell;
    const run = async (d: WindowsServer, l: string) => (await ps(d).processLine(l)).output.join('\n');
    dc1.setCurrentUser('Administrator');
    await run(dc1, 'Install-WindowsFeature -Name AD-Domain-Services -IncludeManagementTools -IncludeAllSubFeature -Restart:$false');
    await run(dc1, 'Install-ADDSForest -DomainName "mandeng.lan" -DomainNetBiosName "MANDENG" -SafeModeAdministratorPassword (ConvertTo-SecureString "DSRM@Mandeng2025!" -AsPlainText -Force) -Force:$true');
    dc2.setCurrentUser('Administrator');
    await run(dc2, 'Install-WindowsFeature -Name AD-Domain-Services -IncludeManagementTools');
    const promotion = await run(dc2, 'Install-ADDSDomainController -DomainName "mandeng.lan" -Credential "Administrator:DSRM@Mandeng2025!" -Server "192.168.10.10" -SafeModeAdministratorPassword (ConvertTo-SecureString "DSRM@Mandeng2025!" -AsPlainText -Force) -Force:$true');

    expect(promotion).not.toMatch(/no reply from replication partner/);
    const utilisateurs = await run(dc2, 'Get-ADUser -Filter * | Select-Object -ExpandProperty SamAccountName');
    expect(utilisateurs).toMatch(/krbtgt/i);
  }, 60000);
});
