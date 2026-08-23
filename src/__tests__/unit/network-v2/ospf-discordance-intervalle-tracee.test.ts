/**
 * OSPF : une discordance de hello/dead ne tracait RIEN.
 *
 * Mesure de depart, sur deux routeurs cables et un `debug ip ospf hello`
 * arme AVANT que le voisin rejoigne : un `ip ospf hello-interval 5` d'un
 * cote — la panne d'adjacence la plus courante — ne produit aucune ligne
 * de journal, alors qu'une discordance de MASQUE produit les deux lignes
 * d'IOS sur la meme machine au meme instant.
 *
 * La cause : `ospf.hello.mismatch` et `ospf.area.mismatch` etaient
 * publies et ecoutes a travers des conversions `as never`, faute d'etre
 * dans l'union `DomainEvent`. Le compilateur etant eteint des deux cotes,
 * le chemin hello/dead publiait sur `ospf.interface.state-changed` — le
 * sujet des transitions d'ETAT d'interface — avec des PHRASES anglaises
 * dans `oldState`/`newState`, la ou le chemin du masque appelait la bonne
 * fonction. L'abonne de `LoggingConfig` ecoutant l'autre sujet, la ligne
 * n'existait pas ; et un abonne des etats d'interface recevait un
 * evenement affirmant qu'une interface est passee a une phrase.
 *
 * Les deux charges sont declarees, les quatre `as never` retires, et le
 * chemin hello/dead passe par `publierDiscordanceHello` comme celui du
 * masque : une seule fonction dit la discordance, donc les deux causes ne
 * peuvent plus se rendre differemment.
 *
 * Le sujet ayant DEUX consommateurs — le journal de la machine et
 * `RouterDebugService`, qui alimente le terminal —, le rendu des deux
 * lignes est ecrit UNE fois (`ospfHelloMismatchLines`) et lu par les
 * deux : deux mises en forme d'un meme evenement finiraient par
 * diverger. `RouterDebugService` n'avait aucun abonne pour ce sujet et
 * rendait a la place la transition d'ETAT detournee, ce qui donnait
 * `OSPF: Interface Gi0/0 state change from hello interval mismatch to
 * Mismatched hello parameters from 10.0.0.2: received 10, configured
 * 30` — une phrase dans chaque champ d'etat. `scenario-debug-04` epinglait
 * cette ligne-la comme contrat ; il demande desormais les mots d'IOS,
 * sous `debug ip ospf hello`, qui est la commande qui les rend.
 *
 * Discrimine par `git stash` sur les fichiers touches : 4 des 6 cas
 * tombent. Les 2 qui passent des deux cotes sont nommes ici — le TEMOIN
 * du masque, dont c'est l'objet (il etait deja correct et prouve que le
 * laboratoire mesure quelque chose), et « une adjacence saine ne trace
 * aucune discordance », le cas de non-regression.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import { Cable } from '@/network/hardware/Cable';

beforeEach(() => { EquipmentRegistry.resetInstance(); });

const run = (d: CiscoRouter, c: string) => Promise.resolve(d.executeCommand(c));

async function taper(r: CiscoRouter, lignes: readonly string[]): Promise<void> {
  for (const l of lignes) await run(r, l);
}

/**
 * R1 arme son debug AVANT que R2 rejoigne, sinon la discordance est deja
 * passee. `avantOspf` s'applique a R2 et porte ce qui doit differer.
 */
async function labo(options: { masqueR2?: string; avantOspf?: readonly string[] } = {}) {
  const r1 = new CiscoRouter('R1');
  const r2 = new CiscoRouter('R2');
  new Cable('c1').connect(r1.getPort('GigabitEthernet0/0')!, r2.getPort('GigabitEthernet0/0')!);
  const plan: [CiscoRouter, string, string][] = [
    [r1, '10.0.0.1', '255.255.255.0'],
    [r2, '10.0.0.2', options.masqueR2 ?? '255.255.255.0'],
  ];
  for (const [r, ip, masque] of plan) {
    await taper(r, ['enable', 'configure terminal', 'interface GigabitEthernet0/0',
      `ip address ${ip} ${masque}`, 'no shutdown', 'end']);
  }
  const vues: string[] = [];
  r1.getLoggingConfig()!.subscribeConsole((l) => vues.push(l));
  await taper(r1, ['configure terminal', 'router ospf 1', 'router-id 1.1.1.1',
    'network 10.0.0.0 0.0.0.255 area 0', 'end']);
  await run(r1, 'debug ip ospf hello');
  await taper(r2, [
    'configure terminal',
    ...(options.avantOspf ?? []),
    'router ospf 1', 'router-id 2.2.2.2',
    'network 10.0.0.0 0.0.0.255 area 0', 'end',
  ]);
  return { r1, r2, vues };
}

describe('OSPF : les deux causes de discordance se tracent pareil', () => {
  it('TEMOIN — une discordance de masque trace les deux lignes', async () => {
    const { vues } = await labo({ masqueR2: '255.255.255.128' });

    const tout = vues.join('\n');
    expect(tout).toMatch(/Mismatched hello parameters from 10\.0\.0\.2/);
    expect(tout).toMatch(/Mask R 255\.255\.255\.128 C 255\.255\.255\.0/);
  });

  it('une discordance de hello-interval trace la meme premiere ligne', async () => {
    const { vues } = await labo({
      avantOspf: ['interface GigabitEthernet0/0', 'ip ospf hello-interval 5', 'exit'],
    });

    expect(vues.join('\n')).toMatch(/Mismatched hello parameters from 10\.0\.0\.2/);
  });

  it('elle compare Recu et Configure sur le parametre fautif', async () => {
    const { vues } = await labo({
      avantOspf: ['interface GigabitEthernet0/0', 'ip ospf hello-interval 5', 'exit'],
    });

    expect(vues.join('\n')).toMatch(/Hello R 5 C 10/);
  });

  it('une discordance de dead-interval se trace aussi', async () => {
    const { vues } = await labo({
      avantOspf: ['interface GigabitEthernet0/0', 'ip ospf dead-interval 60', 'exit'],
    });

    expect(vues.join('\n')).toMatch(/Dead R 60 C 40/);
  });

  it('le terminal recoit les MEMES lignes que le journal', async () => {
    const { r1, vues } = await labo({
      avantOspf: ['interface GigabitEthernet0/0', 'ip ospf hello-interval 5', 'exit'],
    });
    const terminal: string[] = [];
    r1.getDebugService().subscribe((l: string) => terminal.push(l));
    await run(r1, 'debug ip ospf hello');
    await taper(r1, ['configure terminal', 'interface GigabitEthernet0/0',
      'ip ospf hello-interval 7', 'end']);
    await run(r1, 'show ip ospf neighbor');

    const attendues = vues.filter(l => /Mismatched hello parameters from/.test(l));
    expect(attendues.length).toBeGreaterThan(0);
    expect(terminal.some(l => /OSPF: Mismatched hello parameters from 10\.0\.0\.2/.test(l)))
      .toBe(true);
  });

  it('une adjacence saine ne trace aucune discordance', async () => {
    const { vues } = await labo();

    expect(vues.join('\n')).not.toMatch(/Mismatched hello parameters/);
  });
});
