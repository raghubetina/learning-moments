// @ts-check

/**
 * @param {unknown} value
 * @returns {string}
 */
function describe(value) {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

/**
 * @param {string} loc
 * @param {string} kind
 * @param {unknown} value
 * @returns {never}
 */
function fail(loc, kind, value) {
  throw new Error(`${loc}: expected ${kind}, got ${describe(value)}`);
}

/**
 * @param {unknown} value
 * @param {string} loc
 * @returns {string}
 */
export function assertString(value, loc) {
  if (typeof value !== "string") fail(loc, "string", value);
  return value;
}

/**
 * @param {unknown} value
 * @param {string} loc
 * @returns {number}
 */
export function assertNumber(value, loc) {
  if (typeof value !== "number" || !Number.isFinite(value)) fail(loc, "number", value);
  return value;
}

/**
 * @param {unknown} value
 * @param {string} loc
 * @returns {number}
 */
export function assertInteger(value, loc) {
  if (!Number.isInteger(value)) fail(loc, "integer", value);
  return /** @type {number} */ (value);
}

/**
 * @param {unknown} value
 * @param {number} min
 * @param {string} loc
 * @returns {number}
 */
export function assertIntegerMin(value, min, loc) {
  assertInteger(value, loc);
  const n = /** @type {number} */ (value);
  if (n < min) {
    throw new Error(`${loc}: expected integer >= ${min}, got ${n}`);
  }
  return n;
}

/**
 * @param {unknown} value
 * @param {string} loc
 * @returns {boolean}
 */
export function assertBoolean(value, loc) {
  if (typeof value !== "boolean") fail(loc, "boolean", value);
  return value;
}

/**
 * @param {unknown} value
 * @param {string} loc
 * @returns {Record<string, unknown>}
 */
export function assertObject(value, loc) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    fail(loc, "object", value);
  }
  return /** @type {Record<string, unknown>} */ (value);
}

/**
 * @param {Record<string, unknown>} obj
 * @param {readonly string[]} allowed
 * @param {string} loc
 */
export function assertNoExtraKeys(obj, allowed, loc) {
  const allowedSet = new Set(allowed);
  const extras = Object.keys(obj).filter((key) => !allowedSet.has(key));
  if (extras.length > 0) {
    throw new Error(
      `${loc}: unknown key${extras.length > 1 ? "s" : ""} ${extras.map((k) => JSON.stringify(k)).join(", ")}`
    );
  }
}

/**
 * @param {unknown} value
 * @param {string} loc
 * @returns {unknown[]}
 */
export function assertArray(value, loc) {
  if (!Array.isArray(value)) fail(loc, "array", value);
  return value;
}

/**
 * @template {string} T
 * @param {unknown} value
 * @param {readonly T[]} allowed
 * @param {string} loc
 * @returns {T}
 */
export function assertEnum(value, allowed, loc) {
  if (!allowed.includes(/** @type {T} */ (value))) {
    throw new Error(
      `${loc}: expected one of [${allowed.join(", ")}], got ${JSON.stringify(value)}`
    );
  }
  return /** @type {T} */ (value);
}

/**
 * @template T
 * @param {unknown} value
 * @param {(value: unknown, loc: string) => T} validator
 * @param {string} loc
 * @returns {T | undefined}
 */
export function optional(value, validator, loc) {
  if (value === undefined || value === null) return undefined;
  return validator(value, loc);
}
