/**
 * Probe — aide par commentaires des fonctions (ScriptHelp.Tests.ps1 de PowerShell) :
 * `Get-Help <fonction>` renvoie un objet d'aide structure (Synopsis, Description[].Text, alertSet, relatedLinks, examples
 * {introduction, code, remarks x5}, inputTypes, returnValues, Component/Role/Functionality, parameters, syntax.syntaxItem),
 * analyse selon HelpCommentsParser.cs (une directive inconnue ou une ligne de texte avant la premiere directive invalide le
 * bloc ; `#####` ignores ; indentation de la premiere ligne retiree), `f -?`, filtres -Component/-Role/-Functionality
 * (HelpNotFound), lecteur `function:` (Set-Item, New-Item, Test-Path, Get-Content, Remove-Item), index des sources de fonction
 * aussi dans le chemin interactif (beginInteractive).
 * Discrimination : sur la base dde463c56 (HEAD avant ce lot), 28 cas rouges sur 32.
 * Temoins (4, verts avant et apres) : `1 + 1`, une fonction appelee normalement, `Test-Path function:` sur une fonction inexistante,
 * `w4 -Verbose` sur une fonction avancee. Les cas « sans aide : Synopsis = syntaxe » et « commentaire ordinaire » sont rouges sur la
 * base parce que `beginInteractive` n'indexait pas les sources de fonction : Get-Help ne trouvait aucune fonction definie au terminal.
 */
import { describe, it, expect } from 'vitest';
import { PSInterpreter } from '@/powershell/interpreter/PSInterpreter';

function run(code: string): string {
  const interp = new PSInterpreter(undefined, { language: 'core' });
  interp.beginInteractive(code);
  return interp.resumeInteractive().replace(/\r?\n/g, '|');
}

const HELP = [
  '<#',
  '.SYNOPSIS',
  '  A useless function.',
  '.DESCRIPTION',
  '  A description',
  '',
  '      with indented text.',
  '.NOTES',
  '  Mostly harmless.',
  '.LINK',
  '  https://example.test/doc',
  '.LINK',
  '  other commands',
  '.PARAMETER Name',
  '  The name.',
  '.EXAMPLE',
  '  PS>hf -Name foo',
  '',
  '  Adds foo.',
  '.INPUTS',
  '  Anything.',
  '.OUTPUTS',
  '  Nothing.',
  '.COMPONENT',
  '  Something',
  '.ROLE',
  '  CrazyUser',
  '.FUNCTIONALITY',
  '  Useless',
  '#>',
  'function hf {',
  '  param([Parameter(Mandatory=$true)][string]$Name, [switch]$Loud, [System.Management.Automation.CommandTypes]$Kind)',
  '}',
  '',
].join('\n');

const CASES: Array<[string, string, string]> = [
  ['Synopsis', `${HELP}(Get-Help hf).Synopsis`, 'A useless function.'],
  ['Description keeps inner indentation', `${HELP}(Get-Help hf).Description[0].Text`, 'A description||    with indented text.'],
  ['alertSet', `${HELP}(Get-Help hf).alertSet.alert[0].Text`, 'Mostly harmless.'],
  ['link uri', `${HELP}(Get-Help hf).relatedLinks.navigationLink[0].uri`, 'https://example.test/doc'],
  ['link text', `${HELP}(Get-Help hf).relatedLinks.navigationLink[1].linkText`, 'other commands'],
  ['example prompt', `${HELP}(Get-Help hf).examples.example[0].introduction[0].Text`, 'PS>'],
  ['example code', `${HELP}(Get-Help hf).examples.example[0].code`, 'hf -Name foo'],
  ['example remarks', `${HELP}(Get-Help hf).examples.example[0].remarks[0].Text.Trim()`, 'Adds foo.'],
  ['example remarks count', `${HELP}(Get-Help hf).examples.example[0].remarks.Count`, '5'],
  ['input type', `${HELP}(Get-Help hf).inputTypes.inputType.type.name`, 'Anything.'],
  ['return value', `${HELP}(Get-Help hf).returnValues.returnValue.type.name`, 'Nothing.'],
  ['Component Role Functionality', `${HELP}$h = Get-Help hf\n$h.Component + $h.Role + $h.Functionality`, 'SomethingCrazyUserUseless'],
  ['parameter description', `${HELP}(Get-Help hf).parameters.parameter[0].description[0].Text`, 'The name.'],
  ['parameter required', `${HELP}(Get-Help hf).parameters.parameter[0].required`, 'true'],
  ['switch position', `${HELP}(Get-Help hf).syntax.syntaxItem.parameter[1].position`, 'named'],
  ['enum value group', `${HELP}(Get-Help hf).parameters.parameter[2].parameterValueGroup.parameterValue[0]`, 'Alias'],
  ['syntax rendering', `${HELP}(Get-Help hf).syntax | Out-String -Width 300`, 'hf [-Name] <String> [-Loud] [[-Kind] {Alias | Function | Filter | Cmdlet | ExternalScript | Application | Script | Configuration | All}] [<CommonParameters>]|'],
  ['f -?', `${HELP}(hf -?).Synopsis`, 'A useless function.'],
  ['component filter hit', `${HELP}(Get-Help hf -Component Something).Name`, 'hf'],
  ['component filter miss', `${HELP}Get-Help hf -Component blah -ErrorAction SilentlyContinue -ErrorVariable e\n$e[0].FullyQualifiedErrorId`, 'HelpNotFound,Microsoft.PowerShell.Commands.GetHelpCommand'],
  ['empty synopsis', 'function h4 {\n<#\n.Description\n  d\n.Synopsis\n#>\n}\n(Get-Help h4).Synopsis.Length', '0'],
  ['hash separators ignored', '#########\n# .SYNOPSIS\n#    Help on h10\n#########\nfunction h10 {\n}\n(Get-Help h10).Synopsis', 'Help on h10'],
  ['function drive define and call', "Set-Item function:dyn -Value { 'run' }\ndyn", 'run'],
  ['function drive help', "Set-Item function:dyn -Value {\n  # .SYNOPSIS\n  #   Dyn syn.\n  'run'\n}\n(Get-Help dyn).Synopsis", 'Dyn syn.'],
  ['function drive new/test/remove', "New-Item function:n2 -Value { 'two' } | Out-Null\nn2\nTest-Path function:n2\nRemove-Item function:n2\nTest-Path function:n2", 'two|True|False'],
  ['unknown directive voids the block', 'function h5 {\n<#\n.SYNOPSIS\n  s\n.BOGUS\n  x\n#>\nparam($a)\n}\n(Get-Help h5).Synopsis', 'h5 [[-a] <Object>]'],
];

const WITNESSES: Array<[string, string, string]> = [
  ['arithmetic', '1 + 1', '2'],
  ['plain call', 'function w { "called" }\nw', 'called'],
  ['no help: synopsis is syntax', 'function w2 { param($a) }\n(Get-Help w2).Synopsis', 'w2 [[-a] <Object>]'],
  ['absent function', 'Test-Path function:nothing', 'False'],
  ['ordinary comment is not help', '# just a comment\nfunction w3 { param($a) }\n(Get-Help w3).Synopsis', 'w3 [[-a] <Object>]'],
  ['common parameter on an advanced function', 'function w4 { [CmdletBinding()] param($a) "ok" }\nw4 -Verbose', 'ok'],
];

describe('aide par commentaires des fonctions', () => {
  for (const [label, code, expected] of CASES) {
    it(label, () => {
      expect(run(code)).toBe(expected);
    });
  }
});

describe('temoins', () => {
  for (const [label, code, expected] of WITNESSES) {
    it(label, () => {
      expect(run(code)).toBe(expected);
    });
  }
});
