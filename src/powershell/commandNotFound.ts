export function commandNotFoundMessage(name: string): string {
  return `The term '${name}' is not recognized as the name of a cmdlet, function, `
    + `script file, or operable program. Check the spelling of the name, or if a path `
    + `was included, verify that the path is correct and try again.`;
}
