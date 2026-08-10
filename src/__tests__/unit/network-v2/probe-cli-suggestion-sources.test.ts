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
  it('l\'ordre est déclaré une fois, l\'extraction vient en dernier avant le dynamique', () => {
    expect(SUGGESTION_SOURCES.map((s) => s.origin))
      .toEqual(['child', 'param', 'hint', 'auto', 'dynamic']);
  });

  it('un mot extrait du corps du handler est proposé par `?` et par Tab', () => {
    const trie = trieAvecGlouton();
    expect(motsAide(trie, 'show interfaces ')).toContain('summary');
    expect(trie.tabCandidates('show interfaces summ')).toContain('show interfaces summary');
  });

  it('l\'extraction se coupe, et les deux portes se taisent ensemble', () => {
    const trie = trieAvecGlouton();
    trie.setAutoExtractionEnabled(false);
    expect(motsAide(trie, 'show interfaces ')).not.toContain('summary');
    expect(trie.tabCandidates('show interfaces summ')).toEqual([]);
  });

  it('couper l\'extraction ne touche pas aux commandes DÉCLARÉES', () => {
    const trie = trieAvecGlouton();
    trie.setAutoExtractionEnabled(false);
    expect(motsAide(trie, 'show ')).toContain('version');
    expect(motsAide(trie, 'show ')).toContain('interfaces');
    expect(trie.tabCandidates('show ver')).toEqual(['show version']);
  });

  it('l\'extraction est allumée par défaut', () => {
    expect(new CommandTrie().isAutoExtractionEnabled()).toBe(true);
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
