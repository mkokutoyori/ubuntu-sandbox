/*
 * Probe — une GPO s'applique a tous les niveaux de la chaine d'OU d'un
 * objet (ordre LSDOU), et le resultat suit le blocage d'heritage, les liens
 * enforced et l'ordre des liens.
 *
 * Mesure d'origine : `gpupdate` ne lisait que les liens du DOMAINE et ceux
 * de l'OU IMMEDIATE de la machine. Une GPO liee a `OU=Mandeng` n'atteignait
 * donc jamais un poste range dans `OU=Postes,OU=Ordinateurs,OU=Mandeng`, un
 * blocage pose sur un niveau intermediaire etait ignore, et rien ne decidait
 * entre un lien enforced et un lien normal en conflit. La meme regle etait
 * ecrite deux fois — `pullGroupPolicy` (LDAP sur le fil, poste membre) et
 * `DirectoryStore.resultantSetOfPolicy` (DC local) — sans jamais concorder
 * sur ce qu'elles ne faisaient ni l'une ni l'autre. Un seul resolveur
 * (`resolveGroupPolicy`) sert maintenant les deux.
 *
 * Autorite : Microsoft, « Group Policy processing and precedence » — ordre
 * Local, Site, Domain, OU : la GPO du conteneur le plus bas l'emporte sur un
 * conflit ; « Block Inheritance » retire les liens non enforced des
 * conteneurs au-dessus ; un lien « Enforced » s'applique malgre le blocage et
 * l'emporte, celui du conteneur le plus haut d'abord ; dans un conteneur,
 * l'ordre de lien 1 a la priorite la plus haute. Les sites AD ne sont pas
 * modelises : la chaine commence au domaine.
 *
 * Portees : la User Configuration (cles HKCU) se resout sur la chaine d'OU de
 * l'UTILISATEUR, la Computer Configuration (le reste) sur celle de la
 * MACHINE ; une portee ne pretend pas a une GPO que l'autre a bloquee. Sans
 * cela, l'`Administrator` local d'un poste — resolu comme l'Administrator du
 * domaine — ramenait par sa propre chaine les liens du domaine qu'un blocage
 * d'heritage avait retires. `gpresult` liste desormais aussi les GPO de la
 * section USER SETTINGS, et fonctionne sur un DC (il repondait « not a member
 * of a domain »).
 *
 * Mesure avant le correctif (git stash de DirectoryStore, GpoPullClient et
 * WindowsPC) : 5 des 9 cas tombent — l'ancetre lointain, le blocage
 * intermediaire, l'enforced, l'ordre d'affichage et le chemin local.
 * Passent des deux cotes, et pourquoi :
 *  - « TEMOIN : une GPO sur l'OU immediate s'applique » — le banc, la
 *    jonction, gpupdate et la lecture du registre sont sains, donc un echec
 *    des autres cas accuse le resolveur et non le banc.
 *  - « une GPO d'une OU soeur ne s'applique pas » — NON-REGRESSION : la
 *    hierarchie ne fuit pas vers les branches voisines.
 *  - « en conflit, la GPO du conteneur le plus bas l'emporte » et « l'ordre
 *    de lien 1 a la priorite la plus haute » — GARDES : le cas simple
 *    (domaine puis OU immediate, deux liens) etait deja correct ; ils
 *    empechent le resolveur de le perdre.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  ORDINATEURS, POSTES, ROOT, SERVEURS, SIEGE, applied, gpo, joinIn, lab, mode, resetGpoWorld, run,
} from './gpoLab';

beforeEach(resetGpoWorld);

describe('GPO — chaîne LSDOU, blocage, enforced, ordre (poste membre, LDAP sur le fil)', () => {
  it("TEMOIN : une GPO sur l'OU immédiate s'applique", async () => {
    const l = await lab();
    await gpo(l.dc, 'PostesGpo', POSTES);
    await joinIn(l, POSTES);
    expect(await applied(l.client)).toContain('PostesGpo');
  });

  it("une GPO d'une OU soeur ne s'applique pas", async () => {
    const l = await lab();
    await gpo(l.dc, 'ServeursGpo', SERVEURS);
    await joinIn(l, POSTES);
    expect(await applied(l.client)).not.toContain('ServeursGpo');
  });

  it("une GPO liée à un ancêtre lointain s'applique à un poste imbriqué", async () => {
    const l = await lab();
    await gpo(l.dc, 'SiegeGpo', SIEGE);
    await gpo(l.dc, 'OrdinateursGpo', ORDINATEURS);
    await joinIn(l, POSTES);
    const out = await applied(l.client);
    expect(out).toContain('SiegeGpo');
    expect(out).toContain('OrdinateursGpo');
  });

  it("en conflit, la GPO du conteneur le plus bas l'emporte", async () => {
    const l = await lab();
    await gpo(l.dc, 'DomaineGpo', ROOT, 'domaine');
    await gpo(l.dc, 'SiegeGpo', SIEGE, 'siege');
    await gpo(l.dc, 'PostesGpo', POSTES, 'postes');
    await joinIn(l, POSTES);
    expect(await mode(l.client)).toContain('postes');
  });

  it("un blocage d'héritage à un niveau intermédiaire retire les liens non enforced des niveaux au-dessus", async () => {
    const l = await lab();
    await gpo(l.dc, 'DomaineGpo', ROOT);
    await gpo(l.dc, 'SiegeGpo', SIEGE);
    await gpo(l.dc, 'PostesGpo', POSTES);
    await run(l.dc, `Set-GPInheritance -Target "${ORDINATEURS}" -IsBlocked Yes`);
    await joinIn(l, POSTES);
    const out = await applied(l.client);
    expect(out).not.toContain('DomaineGpo');
    expect(out).not.toContain('SiegeGpo');
    expect(out).toContain('PostesGpo');
  });

  it("un lien enforced traverse le blocage et l'emporte sur un lien normal en conflit", async () => {
    const l = await lab();
    await gpo(l.dc, 'DomaineImpose', ROOT, 'impose', '-Enforced Yes');
    await gpo(l.dc, 'PostesGpo', POSTES, 'postes');
    await run(l.dc, `Set-GPInheritance -Target "${ORDINATEURS}" -IsBlocked Yes`);
    await joinIn(l, POSTES);
    const out = await applied(l.client);
    expect(out).toContain('DomaineImpose');
    expect(await mode(l.client)).toContain('impose');
  });

  it("dans un conteneur, l'ordre de lien 1 a la priorité la plus haute", async () => {
    const l = await lab();
    await gpo(l.dc, 'Second', POSTES, 'second', '-Order 2');
    await gpo(l.dc, 'Premier', POSTES, 'premier', '-Order 1');
    await joinIn(l, POSTES);
    expect(await mode(l.client)).toContain('premier');
  });

  it('gpresult liste la GPO gagnante en premier', async () => {
    const l = await lab();
    await gpo(l.dc, 'DomaineGpo', ROOT);
    await gpo(l.dc, 'PostesGpo', POSTES);
    await joinIn(l, POSTES);
    const out = await applied(l.client);
    expect(out.indexOf('PostesGpo')).toBeGreaterThan(-1);
    expect(out.indexOf('PostesGpo')).toBeLessThan(out.indexOf('DomaineGpo'));
  });

  it("chemin local : une GPO d'un niveau intermédiaire s'applique au DC rangé dans une OU imbriquée", async () => {
    const l = await lab();
    await gpo(l.dc, 'SiegeGpo', SIEGE);
    await run(l.dc, `Move-ADObject -Identity "CN=DC01,OU=Domain Controllers,${ROOT}" -TargetPath "${POSTES}"`);
    l.dc.setCurrentUser('Administrator');
    await l.dc.executeCmdCommand('gpupdate /force');
    expect(await l.dc.executeCmdCommand('gpresult /R')).toContain('SiegeGpo');
  });
});
