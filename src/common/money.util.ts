/**
 * Money helpers. All monetary values are plain numbers in a single agreement currency,
 * stored/compared to 2 decimal places.
 *
 * Heads-up: one of the helpers here has a defect that surfaces in `test/cr-totals.spec.ts`.
 */

const CENTS_PER_UNIT = 100;

function toCents(value: number): number {
	return Math.round((value + Number.EPSILON) * CENTS_PER_UNIT);
}

function fromCents(cents: number): number {
	return cents / CENTS_PER_UNIT;
}

/** Round a value to 2 decimal places. */
export function round2(value: number): number {
	return fromCents(toCents(value));
}

/** Sum a list of monetary amounts. */
export function sumMoney(amounts: number[]): number {
	return fromCents(amounts.reduce((acc, n) => acc + toCents(n), 0));
}

/** Compute a single line total = quantity * unitPrice, rounded to 2dp. */
export function lineTotal(quantity: number, unitPrice: number): number {
	return round2(quantity * unitPrice);
}
