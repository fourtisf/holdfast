/** Column conversions shared by the repositories (drivers return int8/numeric as strings). */

export function big(value: unknown): bigint {
  if (typeof value === "bigint") return value;
  if (typeof value === "number") {
    if (!Number.isInteger(value)) throw new Error(`not an integer: ${value}`);
    return BigInt(value);
  }
  if (typeof value === "string") return BigInt(value.includes(".") ? value.slice(0, value.indexOf(".")) : value);
  if (value === null || value === undefined) return 0n;
  throw new Error(`cannot convert ${typeof value} to bigint`);
}

export function bigOrNull(value: unknown): bigint | null {
  return value === null || value === undefined ? null : big(value);
}

export function num(value: unknown): number {
  if (typeof value === "number") return value;
  if (typeof value === "string" || typeof value === "bigint") return Number(value);
  if (value === null || value === undefined) return 0;
  throw new Error(`cannot convert ${typeof value} to number`);
}

export function numOrNull(value: unknown): number | null {
  return value === null || value === undefined ? null : num(value);
}

/** timestamptz → unix ms. */
export function ms(value: unknown): number {
  if (value instanceof Date) return value.getTime();
  if (typeof value === "string") return new Date(value).getTime();
  if (typeof value === "number") return value;
  throw new Error(`cannot convert ${typeof value} to timestamp`);
}

export function msOrNull(value: unknown): number | null {
  return value === null || value === undefined ? null : ms(value);
}

/** unix ms → Date parameter. */
export function ts(valueMs: number): Date {
  return new Date(valueMs);
}

/** bigint parameter (sent as decimal text so both drivers handle it identically). */
export function dec(value: bigint): string {
  return value.toString();
}

export function json(value: unknown): string {
  return JSON.stringify(value);
}

/** Escape LIKE wildcards in user input. */
export function likeEscape(input: string): string {
  return input.replace(/[\\%_]/g, (c) => `\\${c}`);
}

/** Lot ids are bigserial; zero-pad so core's string ordering matches numeric order. */
export function lotId(value: unknown): string {
  return String(value).padStart(20, "0");
}
