/** Decimal amounts as strings: money is compared exactly, never as floats. */

const PATTERN = /^\d+(\.\d+)?$/;

export const isAmount = (s: unknown): s is string => typeof s === "string" && PATTERN.test(s);

/** Both amounts as integers at the same scale. */
function scaled(a: string, b: string): [bigint, bigint] {
  const [ai, af = ""] = a.split(".");
  const [bi, bf = ""] = b.split(".");
  const scale = Math.max(af.length, bf.length);
  return [BigInt(ai + af.padEnd(scale, "0")), BigInt(bi + bf.padEnd(scale, "0"))];
}

/** -1, 0 or 1. Throws on anything that isn't a non-negative decimal. */
export function compare(a: string, b: string): -1 | 0 | 1 {
  if (!isAmount(a) || !isAmount(b)) throw new Error(`not an amount: ${JSON.stringify(isAmount(a) ? b : a)}`);
  const [x, y] = scaled(a, b);
  return x < y ? -1 : x > y ? 1 : 0;
}

export const gt = (a: string, b: string) => compare(a, b) === 1;
export const gte = (a: string, b: string) => compare(a, b) !== -1;

export function add(a: string, b: string): string {
  const [, af = ""] = a.split(".");
  const [, bf = ""] = b.split(".");
  const scale = Math.max(af.length, bf.length);
  const [x, y] = scaled(a, b);
  const digits = (x + y).toString().padStart(scale + 1, "0");
  const out = scale === 0 ? digits : `${digits.slice(0, -scale)}.${digits.slice(-scale)}`;
  return out.includes(".") ? out.replace(/0+$/, "").replace(/\.$/, "") : out;
}

/** a × n, for a whole number n. */
export function times(a: string, n: number): string {
  if (!Number.isInteger(n) || n < 0) throw new Error("times: a non-negative whole number");
  const [, af = ""] = a.split(".");
  const digits = (BigInt(a.replace(".", "")) * BigInt(n)).toString().padStart(af.length + 1, "0");
  const out = af.length === 0 ? digits : `${digits.slice(0, -af.length)}.${digits.slice(-af.length)}`;
  return out.includes(".") ? out.replace(/0+$/, "").replace(/\.$/, "") : out;
}

/** Base units -> decimal string: (12500000n, 6) -> "12.5". */
export function fromBaseUnits(value: bigint, decimals: number): string {
  const digits = value.toString().padStart(decimals + 1, "0");
  const out = decimals === 0 ? digits : `${digits.slice(0, -decimals)}.${digits.slice(-decimals)}`;
  return out.includes(".") ? out.replace(/0+$/, "").replace(/\.$/, "") : out;
}
