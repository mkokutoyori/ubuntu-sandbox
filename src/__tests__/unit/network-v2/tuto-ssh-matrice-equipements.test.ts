/*
 * Chapitre 4 du tutoriel SSH : la matrice complete des equipements.
 *
 * Dix equipements sur un meme segment, chacun configure par ses commandes natives avec un
 * serveur SSH et un compte d'administration : poste et serveur Linux, poste et serveur
 * Windows, routeur et commutateur Cisco IOS, routeur et commutateur Huawei VRP, pare-feu
 * Cisco ASA, pare-feu FortiGate. Chaque equipement ouvre une session SSH INTERACTIVE, tapee
 * dans son propre terminal, vers chacun des neuf autres (90 couples) : il repond aux invites
 * de cle d'hote, de nom d'utilisateur et de mot de passe, arrive sur l'invite du serveur,
 * interroge l'equipement distant sur son propre nom, se deconnecte et retrouve son invite.
 *
 * Mesure avant correction (git stash de src/network, src/terminal et src/shell) : 39 couples
 * sur 90 tombaient.
 *  - un commutateur n'ouvrait aucune session sortante (son adresse de gestion est une SVI que
 *    la recherche de l'adresse locale ignorait) et n'etait pas retrouve comme cible : un
 *    client Linux retombait sur un mini-shell « une commande, un exec » a l'invite inventee
 *    `user@10.0.0.16:~$` ;
 *  - la session SSH d'un commutateur s'ouvrait au niveau 1 (`ios>`) meme pour un compte de
 *    niveau 15, la ou un routeur ouvre `ior#` ;
 *  - `stelnet <hote>` supposait le compte `admin` au lieu de demander « Please input the
 *    username: » ;
 *  - la session distante d'un ASA n'avait aucune invite ;
 *  - l'ASA refusait `show running-config | include hostname` alors que ses modificateurs de
 *    sortie sont ceux d'IOS.
 * Les 51 couples restants passent avant et apres : ils sont les TEMOINS du laboratoire (cables,
 * adressage, comptes, cles d'hote, algorithmes herites d'IOS) et prouvent que les 39 tombaient
 * pour la raison designee et non pour un laboratoire defaillant.
 */
import { describe, it, expect } from 'vitest';
import {
  ALL_KINDS, buildMatrixLab, Console, clientCommand, remotePrompt, identityProbe, logoutCommand,
} from './_helpers/sshMatrixLab';

const pairs = ALL_KINDS.flatMap((a) => ALL_KINDS.filter((b) => b !== a).map((b) => [a, b] as const));

describe('matrix', () => {
  it.each(pairs)('%s -> %s', async (a, b) => {
    const lab = await buildMatrixLab();
    const from = lab.nodes.find((n) => n.kind === a)!;
    const to = lab.nodes.find((n) => n.kind === b)!;
    const c = await Console.open(from.device);
    if (a === 'router-cisco' || a === 'switch-cisco' || a === 'firewall-cisco') await c.type('enable');
    const localPrompt = new RegExp(`^${c.prompt.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`);
    await c.login(clientCommand(a, to), to.secret, to.user);
    const ok = await c.expectPrompt(remotePrompt(to));
    expect(ok).toBe(true);
    const probe = identityProbe(to);
    const before = c.transcript.length;
    await c.type(probe.command);
    expect(c.transcript.slice(before)).toMatch(probe.expected);
    await c.type(logoutCommand(to));
    expect(await c.expectPrompt(localPrompt)).toBe(true);
  }, 60000);
});
