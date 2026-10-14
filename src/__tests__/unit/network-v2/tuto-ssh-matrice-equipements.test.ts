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
 *
 * Les algorithmes sont ceux de chaque produit, regles par ses propres commandes : un IOS 15 n'offre
 * que du SHA-1 (3560 : `diffie-hellman-group1-sha1` seul), si bien que chaque serveur est regle pour
 * l'accepter (`ip ssh server algorithm`, `ssh server key-exchange` VRP, `set ssh-kex-algo` FortiOS,
 * sshd_config) et que les clients VRP, Linux et Windows sont regles pour l'offrir. L'ASA n'accepte
 * qu'UN groupe d'echange (`ssh key-exchange group dh-group14-sha1`) : le 3560 (group1) et le client
 * FortiOS (aucune commande de reglage cote client) ne peuvent donc pas l'atteindre, et ces deux
 * couples sont attendus REFUSES a la negociation.
 */
import { describe, it, expect } from 'vitest';
import {
  ALL_KINDS, buildMatrixLab, Console, clientCommand, remotePrompt, identityProbe, logoutCommand,
} from './_helpers/sshMatrixLab';

const pairs = ALL_KINDS.flatMap((a) => ALL_KINDS.filter((b) => b !== a).map((b) => [a, b] as const));

const REFUSED_AT_KEY_EXCHANGE = new Set(['firewall-fortinet -> firewall-cisco', 'switch-cisco -> firewall-cisco']);

describe('matrix', () => {
  it.each(pairs)('%s -> %s', async (a, b) => {
    const lab = await buildMatrixLab();
    const from = lab.nodes.find((n) => n.kind === a)!;
    const to = lab.nodes.find((n) => n.kind === b)!;
    const c = await Console.open(from.device);
    if (a === 'router-cisco' || a === 'switch-cisco' || a === 'firewall-cisco') await c.type('enable');
    const localPrompt = new RegExp(`^${c.prompt.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`);
    await c.login(clientCommand(a, to), to.secret, to.user);
    if (REFUSED_AT_KEY_EXCHANGE.has(`${a} -> ${b}`)) {
      expect(c.transcript).toMatch(/no matching key exchange method found/);
      expect(await c.expectPrompt(localPrompt)).toBe(true);
      return;
    }
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
