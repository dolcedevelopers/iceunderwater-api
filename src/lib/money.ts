/** Server-side money is always integer cents. Wire format is rands. */

export type Cents = number & { readonly __brand: "Cents" };

export function randsToCents(rands: number): Cents {
  if (!Number.isFinite(rands)) throw new Error("Invalid amount");
  return Math.round(rands * 100) as Cents;
}

export function centsToRands(cents: number): number {
  if (!Number.isInteger(cents)) throw new Error("Cents must be an integer");
  return cents / 100;
}

export function addCents(...parts: number[]): Cents {
  let total = 0;
  for (const part of parts) {
    if (!Number.isInteger(part)) throw new Error("Cents must be an integer");
    total += part;
  }
  return total as Cents;
}
