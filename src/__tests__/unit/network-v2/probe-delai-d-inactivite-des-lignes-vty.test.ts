/*
 * Le delai d'inactivite d'une ligne d'administration etait stocke, rendu... et ignore.
 *
 * Mesure de depart, session SSH ouverte puis laissee muette 90 secondes d'horloge simulee, ligne reglee
 * a une minute :
 *  - routeur Cisco : `exec-timeout 1 0` ferme la session (temoin : c'etait le seul qui fonctionnait) ;
 *  - commutateur Cisco : `exec-timeout 1 0` etait rendu par `show running-config` mais le serveur SSH du
 *    commutateur recevait un delai « aucun » code en dur (`execIdleTimeoutMs: () => null`) ;
 *  - routeur et commutateur Huawei : `idle-timeout 1 0` sous `user-interface vty` est un AUTRE champ de la
 *    ligne que `exec-timeout`, et le calcul du delai ne lisait que le champ Cisco : la session restait
 *    ouverte indefiniment.
 *
 * Corrige : une seule fonction (`lineIdleTimeoutMs`) lit le delai de la ligne, quel que soit le mot
 * du constructeur, et les routeurs comme les commutateurs la consomment pour SSH et pour telnet.
 *
 * Discrimine contre l'etat d'avant (`git stash push -- src/network`) : 3 des 8 cas tombent (commutateur
 * Cisco, routeur Huawei, commutateur Huawei). Les 5 autres sont nommes : le routeur Cisco ferme deja (TEMOIN
 * du laboratoire et de la mesure), et les quatre cas « reste ouverte avec dix minutes » passent partout,
 * car une fermeture systematique aurait fait tomber le temoin du routeur Cisco ; ils prouvent que la
 * fermeture observee vient du delai et non de l'absence de reponse du serveur.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { SimulationClock, installSimulationClock, __resetSimulationClock } from '@/events/SimulationClock';
import { buildMatrixLab, ADMIN, SECRET, Console, type Kind } from './_helpers/sshMatrixLab';

afterEach(() => { __resetSimulationClock(); });

const CONFIGURATION: Record<string, (minutes: number) => string[]> = {
  'router-cisco': (m) => ['configure terminal', 'line vty 0 4', `exec-timeout ${m} 0`, 'end'],
  'switch-cisco': (m) => ['configure terminal', 'line vty 0 4', `exec-timeout ${m} 0`, 'end'],
  'router-huawei': (m) => ['system-view', 'user-interface vty 0 4', `idle-timeout ${m} 0`, 'quit', 'return'],
  'switch-huawei': (m) => ['system-view', 'user-interface vty 0 4', `idle-timeout ${m} 0`, 'quit', 'return'],
};

async function promptAfterSilence(kind: Kind, minutes: number, silenceSeconds: number): Promise<string> {
  const clock = installSimulationClock(new SimulationClock({
    startPump: () => () => undefined, originMs: Date.UTC(2026, 9, 8, 9, 0, 0),
  }));
  const lab = await buildMatrixLab(['linux-pc', kind]);
  const [pc, target] = lab.nodes;
  for (const line of CONFIGURATION[kind](minutes)) {
    await (target.device as unknown as { executeCommand(c: string): Promise<string> }).executeCommand(line);
  }
  const session = await Console.open(pc.device);
  await session.login(`ssh ${ADMIN}@${target.ip}`, SECRET, ADMIN);
  await clock.advance(silenceSeconds * 1000);
  await session.type(kind.endsWith('huawei') ? 'display clock' : 'show clock');
  return session.prompt;
}

for (const kind of Object.keys(CONFIGURATION) as Kind[]) {
  describe(kind, () => {
    it('ferme la session inactive plus longtemps que le delai de la ligne', async () => {
      expect(await promptAfterSilence(kind, 1, 90)).toMatch(/lpc/);
    }, 30000);

    it('temoin : laisse ouverte une session inactive moins longtemps que le delai', async () => {
      const prompt = await promptAfterSilence(kind, 10, 90);
      expect(prompt).not.toMatch(/lpc/);
    }, 30000);
  });
}
