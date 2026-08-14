import { describe, it, expect } from 'vitest';
import { CommandTrie } from '@/network/devices/shells/CommandTrie';
import { SUGGESTION_SOURCES } from '@/network/devices/shells/cli/SuggestionSources';

function trieAvecGlouton(): CommandTrie {
  const trie = new CommandTrie();
  trie.registerGreedy('show interfaces', 'Display interfaces', (args) => {
    if (args[0] === 'summary') return 'summary';
    if (args[0] === 'counters') return 'counters';
    return '';
  });
  trie.register('show version', 'Display version', () => 'version');
  return trie;
}

const motsAide = (trie: CommandTrie, entree: string): string[] =>
  trie.getCompletions(entree).map((c) => c.keyword);

describe('les cinq sources de suggestion', () => {
  it('l\'ordre est déclaré une fois, la suite déclarée vient avant le dynamique', () => {
    expect(SUGGESTION_SOURCES.map((s) => s.origin))
      .toEqual(['child', 'param', 'hint', 'auto', 'dynamic']);
  });

  // La source `auto` a change de NATURE : elle lisait le texte source du
  // gestionnaire, elle lit desormais ce qui a ete declare. Le mot cite
  // par le corps ne suffit plus, et c'est tout l'objet du changement.
  it('un mot seulement CITÉ par le corps n\'est pas proposé', () => {
    const trie = trieAvecGlouton();
    expect(motsAide(trie, 'show interfaces ')).not.toContain('summary');
    expect(trie.tabCandidates('show interfaces summ')).toEqual([]);
  });

  it('le même mot DÉCLARÉ l\'est par les deux portes', () => {
    const trie = trieAvecGlouton();
    trie.declareContinuations('show interfaces', ['summary', 'counters']);
    expect(motsAide(trie, 'show interfaces ')).toContain('summary');
    expect(trie.tabCandidates('show interfaces summ')).toContain('show interfaces summary');
  });

  it('et une déclaration ne touche pas aux commandes enregistrées', () => {
    const trie = trieAvecGlouton();
    trie.declareContinuations('show interfaces', ['summary']);
    expect(motsAide(trie, 'show ')).toContain('version');
    expect(motsAide(trie, 'show ')).toContain('interfaces');
    expect(trie.tabCandidates('show ver')).toEqual(['show version']);
  });

  it('une valeur vivante ne se propose que si aucun mot-clé ne convient', () => {
    const trie = new CommandTrie();
    trie.registerGreedy('interface', 'Select interface', () => '');
    trie.setDynamicResolver({
      candidatesFor: () => ['GigabitEthernet0/0', 'GigabitEthernet0/1'],
    });
    trie.registerSuggestions('interface', [
      { keyword: 'range', description: 'Range of interfaces' },
    ]);
    expect(trie.tabCandidates('interface ra')).toEqual(['interface range']);
    expect(trie.tabCandidates('interface Gig'))
      .toEqual(['interface GigabitEthernet0/0', 'interface GigabitEthernet0/1']);
  });
});
