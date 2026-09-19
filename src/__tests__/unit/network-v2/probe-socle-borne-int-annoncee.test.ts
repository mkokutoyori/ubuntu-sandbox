/**
 * Le type `INT` du socle ANNONCAIT une borne qu'il n'appliquait pas.
 *
 * `ARGUMENT_TYPES.INT` declarait `placeholder: '<0-4294967295>'` et
 * `accepts: (t) => /^\d+$/.test(t)`. L'aide affichait donc une borne
 * haute que rien ne verifiait : `send 99999999999999999999` passait.
 *
 * C'est exactement l'invariant que CLAUDE.md nomme -- « une borne
 * annoncee est une borne appliquee » -- pris a la racine plutot que sur
 * une commande : toute place declaree `INT` sans `range` explicite herite
 * de cette annonce, donc toutes heritaient du meme trou. Et c'est aussi
 * la regle 6 : un critere affiche, jamais evalue.
 *
 * La borne elle-meme n'est pas inventee : 4294967295 est le maximum d'un
 * entier non signe de 32 bits, et c'est la valeur que le socle annoncait
 * DEJA. Ce lot ne change pas ce qui est annonce ; il le fait tenir.
 *
 * `send <ligne>` (`ciscoExecSpecs`, mode privilegie) sert de place
 * temoin : c'est une des rares places declarees `INT` sans `range`
 * propre, donc celle qui montre le type nu.
 *
 * Discrimine par `git stash push -- src/cli` : UN cas sur 3 tombe, et
 * c'est la mesure honnete. Les deux autres passent des deux cotes et il
 * faut dire pourquoi :
 *  - TEMOIN : une valeur DANS la borne reste acceptee. Sans lui,
 *    « la commande refuse » et « la commande n'existe pas » seraient
 *    indiscernables.
 *  - « l'aide annonce la borne » est une NON-REGRESSION : l'annonce
 *    existait deja -- c'est meme tout le probleme -- et le correctif ne
 *    doit pas la changer. Ce qui tombe, c'est le seul cas qui MESURE
 *    l'ecart entre ce qui est annonce et ce qui est accepte.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { MACAddress, resetCounters } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';

beforeEach(() => {
  resetCounters(); resetDeviceCounters(); MACAddress.resetCounter();
});

const BORNE_ANNONCEE = 4294967295;

async function privilegie(): Promise<CiscoRouter> {
  const r = new CiscoRouter('R1', 0, 0);
  await r.executeCommand('enable');
  return r;
}

describe('socle : une borne annoncee par le TYPE est une borne appliquee', () => {
  it('TEMOIN : une valeur dans la borne reste acceptee', async () => {
    const r = await privilegie();
    expect(await r.executeCommand('send 5')).not.toContain('Invalid input');
  });

  it('l aide annonce la borne du type', async () => {
    const r = await privilegie();
    expect(await r.executeCommand('send ?')).toContain(`<0-${BORNE_ANNONCEE}>`);
  });

  it('une valeur AU-DESSUS de la borne annoncee est refusee', async () => {
    const r = await privilegie();
    for (const trop of [String(BORNE_ANNONCEE + 1), '99999999999999999999']) {
      expect(await r.executeCommand(`send ${trop}`)).toContain('Invalid input');
    }
    expect(await r.executeCommand(`send ${BORNE_ANNONCEE}`))
      .not.toContain('Invalid input');
  });
});
