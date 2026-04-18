/**
 * Assertion helpers for non-null / in-bounds access.
 * @module required
 */

/**
 * Assert that `value` is neither `null` nor `undefined`.
 * Throws the provided message otherwise.
 *
 * @typeParam T - The non-nullable value type.
 * @param value - The value to assert.
 * @param message - Error message if the value is nullish.
 * @returns The asserted non-null value.
 * @throws {Error} If `value` is `null` or `undefined`.
 */
export function requireDefined<T>(value: T | null | undefined, message: string): T {
  if (value === undefined || value === null) {
    throw new Error(message);
  }

  return value;
}

/**
 * Retrieve `values[index]`, throwing if the index is out of bounds.
 *
 * @typeParam T - The element type.
 * @param values - Read-only array to index into.
 * @param index - Zero-based index.
 * @param message - Error message if the element is missing.
 * @returns The element at `index`.
 * @throws {Error} If the index is out of bounds.
 */
export function requireArrayValue<T>(values: readonly T[], index: number, message: string): T {
  return requireDefined(values[index], message);
}
