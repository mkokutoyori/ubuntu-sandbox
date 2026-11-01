/**
 * `nc -l` (netcat-openbsd 1.226) pose SO_REUSEADDR ET SO_REUSEPORT avant de lier (local_listen) : deux `nc -l 9000` du meme
 * utilisateur coexistent, `ss -ltn` montre deux lignes LISTEN sur le port, et le noyau repartit les connexions entrantes entre eux
 * par le hachage du flux (reuseport_select_sock) ; un autre utilisateur, ou un ecouteur sans l'option, recoit EADDRINUSE.
 * Le simulateur refusait le second (SocketTable.bind et TcpStack.listen n'admettaient qu'un ecouteur par adresse et port).
 * Corrige dans les trois couches : TcpStack garde les pairs d'un groupe (choix de l'ecouteur par hachage de la source,
 * fermeture par pid), SocketTable admet les liaisons du meme proprietaire et ne libere la cle qu'avec la derniere, et le puits
 * d'ecoute les relie par pid. Reste hors de ce lot : UDP (`nc -lu`), qui garde un ecouteur par port (TODO).
 *
 * Discrimine par `git stash` sur src/network : 3 des 6 cas tombent avant. TEMOINS : un seul `nc -l` ecoute ; un ecouteur d'un autre service
 * garde son EADDRINUSE ; une connexion atteint l'un des deux (avant, elle atteignait l'unique ecouteur).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';

beforeEach(() => { EquipmentRegistry.getInstance().clear(); });

async function lab(): Promise<(command: string) => Promise<string>> {
  const pc = new LinuxPC('linux-pc', 'P');
  pc.powerOn();
  const machine = pc as unknown as { executor: { runAsUser<T>(user: string, run: () => Promise<T>): Promise<T> } };
  return async (command) => String(await machine.executor.runAsUser('root', () => pc.executeCommand(command))).trim();
}

const rows = (output: string): number => output.split('\n').filter((line) => line.includes(':9000 ')).length;

describe('nc -l and SO_REUSEPORT', () => {
  it('WITNESS — one nc -l listens', async () => {
    const run = await lab();
    await run('nc -l 9000 &');
    expect(rows(await run('ss -ltn'))).toBe(1);
  });

  it('WITNESS — a service that is not nc keeps EADDRINUSE', async () => {
    const run = await lab();
    await run('nc -l 9000 &');
    expect(await run('nc -l 22; echo rc=$?')).toContain('rc=1');
  });

  it('a second nc -l on the same port is accepted', async () => {
    const run = await lab();
    await run('nc -l 9000 &');
    expect(await run('nc -l 9000; echo rc=$?')).toBe('rc=0');
  });

  it('ss shows one LISTEN row per nc', async () => {
    const run = await lab();
    await run('nc -l 9000 &');
    await run('nc -l 9000 &');
    expect(rows(await run('ss -ltn'))).toBe(2);
  });

  it('killing one leaves the other listening', async () => {
    const run = await lab();
    await run('nc -l 9000 &');
    await run('nc -l 9000 &');
    await run('kill %1');
    expect(rows(await run('ss -ltn'))).toBe(1);
    await run('kill %2');
    expect(rows(await run('ss -ltn'))).toBe(0);
  });

  it('a connection reaches one of the two listeners', async () => {
    const run = await lab();
    await run('nc -l 9000 &');
    await run('nc -l 9000 &');
    expect(await run('printf "hello\\n" | nc -N 127.0.0.1 9000; echo rc=$?')).toContain('rc=0');
  });
});
