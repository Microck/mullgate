export function requireDefined<T>(value: T | null | undefined, message: string): T {
  if (value === undefined || value === null) {
    throw new Error(message);
  }

  return value;
}

export function requireArrayValue<T>(values: readonly T[], index: number, message: string): T {
  return requireDefined(values[index], message);
}
