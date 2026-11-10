/**
 * Money is always integer minor units (cents, fils, piastres...). No float ever
 * touches a balance, so rounding error cannot enter the ledger. A "Minor" is just
 * a number the code has checked is a safe integer.
 */
export type Minor = number

export function assertMinor(amount: number, label = "amount"): asserts amount is Minor {
  if (typeof amount !== "number" || !Number.isFinite(amount)) {
    throw new TypeError(`${label} must be a finite number, got ${String(amount)}`)
  }
  if (!Number.isInteger(amount)) {
    throw new TypeError(`${label} must be integer minor units (no fractions), got ${amount}`)
  }
  if (!Number.isSafeInteger(amount)) {
    throw new TypeError(`${label} exceeds the safe integer range`)
  }
}
