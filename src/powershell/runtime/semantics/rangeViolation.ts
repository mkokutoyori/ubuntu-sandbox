export function rangeViolation(
  shown: string, value: number, minimum?: number, maximum?: number, format: (bound: number) => string = String,
): string | null {
  if (minimum !== undefined && value < minimum) {
    return `The ${shown} argument is less than the minimum allowed range of ${format(minimum)}. Supply an argument that is greater than or equal to ${format(minimum)} and then try the command again.`;
  }
  if (maximum !== undefined && value > maximum) {
    return `The ${shown} argument is greater than the maximum allowed range of ${format(maximum)}. Supply an argument that is less than or equal to ${format(maximum)} and then try the command again.`;
  }
  return null;
}
