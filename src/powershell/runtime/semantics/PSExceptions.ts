const PARENTS: Readonly<Record<string, string>> = {
  'System.Exception': '',
  'System.SystemException': 'System.Exception',
  'System.ArithmeticException': 'System.SystemException',
  'System.DivideByZeroException': 'System.ArithmeticException',
  'System.OverflowException': 'System.ArithmeticException',
  'System.FormatException': 'System.SystemException',
  'System.InvalidCastException': 'System.SystemException',
  'System.ArgumentException': 'System.SystemException',
  'System.ArgumentNullException': 'System.ArgumentException',
  'System.ArgumentOutOfRangeException': 'System.ArgumentException',
  'System.InvalidOperationException': 'System.SystemException',
  'System.NullReferenceException': 'System.SystemException',
  'System.NotSupportedException': 'System.SystemException',
  'System.NotImplementedException': 'System.SystemException',
  'System.IndexOutOfRangeException': 'System.SystemException',
  'System.IO.IOException': 'System.SystemException',
  'System.IO.FileNotFoundException': 'System.IO.IOException',
  'System.IO.DirectoryNotFoundException': 'System.IO.IOException',
  'System.UnauthorizedAccessException': 'System.SystemException',
  'System.Management.Automation.RuntimeException': 'System.SystemException',
  'System.Management.Automation.PSInvalidCastException': 'System.InvalidCastException',
  'System.Management.Automation.ParameterBindingException': 'System.Management.Automation.RuntimeException',
  'System.Management.Automation.ParameterBindingValidationException': 'System.Management.Automation.ParameterBindingException',
  'System.Management.Automation.ParameterBindingArgumentTransformationException': 'System.Management.Automation.ParameterBindingException',
  'System.Management.Automation.MethodInvocationException': 'System.Management.Automation.RuntimeException',
  'System.Management.Automation.CommandNotFoundException': 'System.Management.Automation.RuntimeException',
  'System.Management.Automation.ItemNotFoundException': 'System.Management.Automation.SessionStateException',
  'System.Management.Automation.SessionStateException': 'System.Management.Automation.RuntimeException',
  'System.Management.Automation.ActionPreferenceStopException': 'System.Management.Automation.RuntimeException',
  'System.Management.Automation.PSArgumentException': 'System.ArgumentException',
  'Microsoft.PowerShell.Commands.WriteErrorException': 'System.Management.Automation.RuntimeException',
};

export function exceptionAncestry(fullName: string): string[] {
  const chain: string[] = [];
  let current: string | undefined = fullName;
  while (current !== undefined && current !== '') {
    chain.push(current);
    current = PARENTS[current];
  }
  return chain;
}

function shortName(fullName: string): string {
  return fullName.slice(fullName.lastIndexOf('.') + 1);
}

export function exceptionMatches(actualFullName: string, catchTypeName: string): boolean {
  const wanted = catchTypeName.replace(/^\[|\]$/g, '').trim().toLowerCase();
  return exceptionAncestry(actualFullName).some(name =>
    name.toLowerCase() === wanted || shortName(name).toLowerCase() === wanted);
}

export function exceptionShortName(fullName: string): string {
  return shortName(fullName);
}

export function resolveExceptionType(typeName: string): string | null {
  const wanted = typeName.replace(/^\[|\]$/g, '').trim().toLowerCase();
  const known = Object.keys(PARENTS).find(name =>
    name.toLowerCase() === wanted || (wanted.indexOf('.') < 0 && shortName(name).toLowerCase() === wanted));
  return known ?? null;
}

export function defaultExceptionMessage(fullName: string): string {
  return `Exception of type '${fullName}' was thrown.`;
}

export function makeExceptionObject(typeName: string, message: string): Record<string, unknown> {
  return {
    Message: message,
    __type__: typeName,
    HResult: 0,
    Source: null,
    StackTrace: null,
    InnerException: null,
    toString: () => `${typeName}: ${message}`,
  };
}
