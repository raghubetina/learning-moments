function describe(value) {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

function fail(loc, kind, value) {
  throw new Error(`${loc}: expected ${kind}, got ${describe(value)}`);
}

export function assertString(value, loc) {
  if (typeof value !== "string") fail(loc, "string", value);
  return value;
}

export function assertNumber(value, loc) {
  if (typeof value !== "number" || !Number.isFinite(value)) fail(loc, "number", value);
  return value;
}

export function assertInteger(value, loc) {
  if (!Number.isInteger(value)) fail(loc, "integer", value);
  return value;
}

export function assertIntegerMin(value, min, loc) {
  assertInteger(value, loc);
  if (value < min) {
    throw new Error(`${loc}: expected integer >= ${min}, got ${value}`);
  }
  return value;
}

export function assertBoolean(value, loc) {
  if (typeof value !== "boolean") fail(loc, "boolean", value);
  return value;
}

export function assertObject(value, loc) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    fail(loc, "object", value);
  }
  return value;
}

export function assertArray(value, loc) {
  if (!Array.isArray(value)) fail(loc, "array", value);
  return value;
}

export function assertEnum(value, allowed, loc) {
  if (!allowed.includes(value)) {
    throw new Error(
      `${loc}: expected one of [${allowed.join(", ")}], got ${JSON.stringify(value)}`
    );
  }
  return value;
}

export function optional(value, validator, loc) {
  if (value === undefined || value === null) return undefined;
  return validator(value, loc);
}
