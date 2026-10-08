/*
 * Mesure de depart : `ssh -J user@rebond user@10.0.0.99` (10.0.0.99 ne porte aucune machine) ne
 * rendait jamais la main. Le serveur de rebond ouvrait le canal direct-tcpip par `dialTcp`, dont la
 * promesse ne se regle que par un RST ou l'epuisement des retransmissions du SYN ; un voisin sans
 * reponse ARP ne produit ni l'un ni l'autre tant que l'horloge n'avance pas, alors qu'un noyau Linux
 * rend EHOSTUNREACH ("No route to host") apres l'echec de la resolution de voisin.
 * Sans correctif : 1 cas sur 3 tombe (delai de 20 s depasse). Temoins qui passent dans les deux
 * etats : « hote present » (le laboratoire est sain) et « port ferme sur un hote present » (le
 * refus reste un refus, pas un « No route »).
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { buildMatrixLab, ADMIN, SECRET, type MatrixLab } from './_helpers/sshMatrixLab';

interface Cli { executeCommand(command: string): Promise<string> }

let lab: MatrixLab;
const pc = (): Cli => lab.nodes[0].device as unknown as Cli;
const server = () => lab.nodes[1];
const jump = (target: string, port = 22) =>
  `sshpass -p ${SECRET} ssh -o StrictHostKeyChecking=no -p ${port} -J ${ADMIN}@${server().ip} ${ADMIN}@${target} hostname`;

beforeAll(async () => { lab = await buildMatrixLab(['linux-pc', 'linux-server']); }, 120000);

describe('rebond SSH vers une adresse sans machine', () => {
  it('temoin : un hote present repond a travers le rebond', async () => {
    expect(await pc().executeCommand(jump(server().ip))).toContain('lsrv');
  });

  it('un port ferme sur un hote present reste « Connection refused »', async () => {
    const out = await pc().executeCommand(jump(server().ip, 2222));
    expect(out).toMatch(/refused/i);
    expect(out).not.toContain('No route to host');
  }, 20000);

  it('une adresse sans machine rend « No route to host » au lieu de pendre', async () => {
    const out = await pc().executeCommand(jump('10.0.0.99'));
    expect(out).toContain('No route to host');
  }, 20000);
});
