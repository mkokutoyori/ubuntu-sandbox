/**
 * cron n'a pas de terminal : sa commande ne va pas dans `history`.
 *
 * bash ne tient d'historique que pour un shell interactif ; cron lance
 * son `sh -c` sans terminal, et rien de ce qu'il exécute n'apparaît dans
 * le `history` de l'opérateur. Ici, `runCronJob` passait par le même
 * `execute()` qu'une ligne tapée au prompt, qui empile tout ce qu'il
 * reçoit — la commande de cron s'intercalait donc dans la numérotation
 * d'un utilisateur qui n'avait rien tapé.
 *
 * Trouvé par une régression complète : `linux-history.test.ts` échouait
 * quand la machine était assez chargée pour que le minuteur de cron
 * tombe pendant le test, et l'entrée intruse était l'horaire de Debian,
 * `cd / && run-parts --report /etc/cron.hourly`. Le test mesurait la
 * charge de la machine ; le défaut, lui, était réel et permanent.
 *
 * La trace de cron n'est pas perdue pour autant : elle est dans syslog,
 * là où un vrai système la met — et c'est le second cas ci-dessous.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';

beforeEach(() => { EquipmentRegistry.resetInstance(); });

function lab(): { pc: LinuxPC; tick: (minute: number) => void } {
  const pc = new LinuxPC('linux-pc', 'pc1', 0, 0);
  pc.powerOn();
  const machine = pc as unknown as {
    cronTick(at?: Date): void;
    cronTimer: symbol | null;
    hostTimers: { clear(id: symbol): void };
  };
  // Horloge pilotée : sans cela, la sonde mesurerait l'heure qu'il est.
  if (machine.cronTimer) { machine.hostTimers.clear(machine.cronTimer); machine.cronTimer = null; }
  const base = new Date(2026, 0, 1, 9, 0, 0).getTime();
  return { pc, tick: (minute) => machine.cronTick(new Date(base + minute * 60_000)) };
}

describe('cron n\'écrit pas dans l\'historique de l\'opérateur', () => {
  it('la commande de cron n\'apparaît pas dans history', async () => {
    const { pc, tick } = lab();
    await pc.executeCommand('echo "* * * * * echo tick >> /home/user/t.txt" | crontab -');
    tick(1);

    // Elle s'est bien exécutée — sinon on ne mesurerait rien.
    expect(await pc.executeCommand('cat /home/user/t.txt')).toBe('tick');

    // La mesure porte sur des lignes ENTIÈRES, pas sur une sous-chaîne :
    // le texte de la tâche figure aussi dans le `crontab -` que
    // l'opérateur a tapé, et celui-là a toute sa place dans l'historique.
    // Chercher la sous-chaîne ne distinguait donc rien.
    const commandes = (await pc.executeCommand('history'))
      .split('\n')
      .map((l) => l.replace(/^\s*\d+\s+/, ''));
    expect(commandes).not.toContain('echo tick >> /home/user/t.txt');
    expect(commandes.some((c) => c.startsWith('echo "* * * * *'))).toBe(true);
  });

  it('et ne décale pas la numérotation de ce que l\'opérateur a tapé', async () => {
    const { pc, tick } = lab();
    await pc.executeCommand('echo "* * * * * /bin/true" | crontab -');
    await pc.executeCommand('history -c');
    await pc.executeCommand('echo premier');
    tick(1);
    await pc.executeCommand('echo second');

    // C'est la forme exacte sous laquelle le défaut se manifestait :
    // une ligne de plus, donc un numéro de plus, entre deux commandes
    // consécutives de l'utilisateur.
    const hist = await pc.executeCommand('history');
    const lignes = hist.split('\n').filter((l) => l.trim());
    expect(lignes[0]).toContain('echo premier');
    expect(lignes[1]).toContain('echo second');
  });

  it('mais syslog garde la trace — c\'est là qu\'un vrai système la met', async () => {
    const { pc, tick } = lab();
    await pc.executeCommand('echo "* * * * * /bin/true" | crontab -');
    tick(1);

    expect(await pc.executeCommand('grep -c CRON /var/log/syslog')).toBe('1');
    expect(await pc.executeCommand('grep CRON /var/log/syslog')).toContain('/bin/true');
  });

  it('une commande tapée juste après cron s\'enregistre normalement', async () => {
    const { pc, tick } = lab();
    await pc.executeCommand('echo "* * * * * /bin/true" | crontab -');
    tick(1);
    await pc.executeCommand('echo apres');

    // Le témoin : la suppression est bornée au travail de cron, elle ne
    // laisse pas l'historique éteint derrière elle.
    expect(await pc.executeCommand('history')).toContain('echo apres');
  });
});
