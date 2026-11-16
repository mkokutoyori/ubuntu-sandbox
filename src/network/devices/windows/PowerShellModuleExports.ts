export const MODULE_EXPORTS: Readonly<Record<string, readonly string[]>> = {
  'Microsoft.PowerShell.Management': [
    'add-content', 'clear-content', 'clear-item', 'clear-itemproperty', 'clear-recyclebin', 'convert-path',
    'copy-item', 'copy-itemproperty', 'debug-process', 'get-childitem', 'get-clipboard', 'get-computerinfo',
    'get-content', 'get-hotfix', 'get-item', 'get-itemproperty', 'get-itempropertyvalue', 'get-location',
    'get-process', 'get-psdrive', 'get-psprovider', 'get-service', 'get-timezone', 'invoke-item', 'join-path',
    'move-item', 'move-itemproperty', 'new-item', 'new-itemproperty', 'new-psdrive', 'new-service', 'pop-location',
    'push-location', 'remove-item', 'remove-itemproperty', 'remove-psdrive', 'remove-service', 'rename-computer',
    'rename-item', 'rename-itemproperty', 'resolve-path', 'restart-computer', 'restart-service', 'resume-service',
    'set-clipboard', 'set-content', 'set-item', 'set-itemproperty', 'set-location', 'set-service', 'set-timezone',
    'split-path', 'start-process', 'start-service', 'stop-computer', 'stop-process', 'stop-service',
    'suspend-service', 'test-connection', 'test-path', 'wait-process',
  ],
  'Microsoft.PowerShell.Utility': [
    'add-member', 'add-type', 'clear-variable', 'compare-object', 'convertfrom-clixml', 'convertfrom-csv',
    'convertfrom-json', 'convertfrom-markdown', 'convertfrom-sddlstring', 'convertfrom-stringdata',
    'convertto-clixml', 'convertto-csv', 'convertto-html', 'convertto-json', 'convertto-xml', 'debug-runspace',
    'disable-psbreakpoint', 'disable-runspacedebug', 'enable-psbreakpoint', 'enable-runspacedebug', 'export-alias',
    'export-clixml', 'export-csv', 'export-formatdata', 'export-pssession', 'format-custom', 'format-hex',
    'format-list', 'format-table', 'format-wide', 'get-alias', 'get-culture', 'get-date', 'get-error', 'get-event',
    'get-eventsubscriber', 'get-filehash', 'get-formatdata', 'get-host', 'get-markdownoption', 'get-member',
    'get-psbreakpoint', 'get-pscallstack', 'get-random', 'get-runspace', 'get-runspacedebug', 'get-securerandom',
    'get-tracesource', 'get-typedata', 'get-uiculture', 'get-unique', 'get-uptime', 'get-variable', 'get-verb',
    'group-object', 'import-alias', 'import-clixml', 'import-csv', 'import-localizeddata',
    'import-powershelldatafile', 'import-pssession', 'invoke-expression', 'invoke-restmethod', 'invoke-webrequest',
    'join-string', 'measure-command', 'measure-object', 'new-alias', 'new-event', 'new-guid', 'new-object',
    'new-temporaryfile', 'new-timespan', 'new-variable', 'out-file', 'out-gridview', 'out-printer', 'out-string',
    'read-host', 'register-engineevent', 'register-objectevent', 'remove-alias', 'remove-event',
    'remove-psbreakpoint', 'remove-typedata', 'remove-variable', 'select-object', 'select-string', 'select-xml',
    'send-mailmessage', 'set-alias', 'set-date', 'set-markdownoption', 'set-psbreakpoint', 'set-tracesource',
    'set-variable', 'show-command', 'show-markdown', 'sort-object', 'start-sleep', 'tee-object', 'test-json',
    'trace-command', 'unblock-file', 'unregister-event', 'update-formatdata', 'update-list', 'update-typedata',
    'wait-debugger', 'wait-event', 'write-debug', 'write-error', 'write-host', 'write-information', 'write-output',
    'write-progress', 'write-verbose', 'write-warning',
  ],
  'Microsoft.PowerShell.Security': [
    'convertfrom-securestring', 'convertto-securestring', 'get-acl', 'get-authenticodesignature', 'get-cmsmessage',
    'get-credential', 'get-executionpolicy', 'get-pfxcertificate', 'new-filecatalog', 'protect-cmsmessage', 'set-acl',
    'set-authenticodesignature', 'set-executionpolicy', 'test-filecatalog', 'unprotect-cmsmessage',
  ],
  'Microsoft.PowerShell.Diagnostics': [
    'get-counter', 'get-winevent', 'new-winevent',
  ],
};

const MODULE_OF_COMMAND: ReadonlyMap<string, string> = new Map(
  Object.entries(MODULE_EXPORTS).flatMap(([module, commands]) => commands.map((command): [string, string] => [command, module])),
);

export function moduleOfCommand(command: string): string | null {
  return MODULE_OF_COMMAND.get(command.toLowerCase()) ?? null;
}

export const POSITIONAL_PARAMETERS: Readonly<Record<string, readonly string[]>> = {
  'get-process': ['Name'],
  'get-service': ['Name'],
  'start-service': ['Name'],
  'stop-service': ['Name'],
  'restart-service': ['Name'],
  'get-childitem': ['Path', 'Filter'],
  'get-content': ['Path'],
  'set-content': ['Path', 'Value'],
  'add-content': ['Path', 'Value'],
  'get-item': ['Path'],
  'get-itemproperty': ['Path', 'Name'],
  'set-itemproperty': ['Path', 'Name', 'Value'],
  'new-item': ['Path'],
  'remove-item': ['Path'],
  'copy-item': ['Path', 'Destination'],
  'move-item': ['Path', 'Destination'],
  'test-path': ['Path'],
  'set-location': ['Path'],
  'get-date': ['Date'],
  'get-acl': ['Path'],
  'set-acl': ['Path', 'AclObject'],
  'write-output': ['InputObject'],
  'write-host': ['Object'],
  'write-error': ['Message'],
  'select-object': ['Property'],
  'sort-object': ['Property'],
  'group-object': ['Property'],
  'measure-object': ['Property'],
  'format-table': ['Property'],
  'format-list': ['Property'],
  'convertto-json': ['InputObject'],
  'out-file': ['FilePath'],
  'select-string': ['Pattern', 'Path'],
  'get-winevent': ['LogName'],
};

export function positionalParameterNames(command: string): readonly string[] {
  return POSITIONAL_PARAMETERS[command.toLowerCase()] ?? [];
}
