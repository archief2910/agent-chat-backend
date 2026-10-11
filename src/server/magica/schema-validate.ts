import { AppError } from "@/lib/errors";
import type { JsonSchema } from "@/server/magica/client";

type Issue = { path: string[]; message: string };

/**
 * Checks a payload against the live Magica JSON schema: required fields, types,
 * enums, numeric ranges, array lengths, and uri strings. Unknown keys are dropped.
 */
export function conformToSchema(input: Record<string, unknown>, schema: JsonSchema): Record<string, unknown> {
  const properties = schema.properties ?? {};
  const issues: Issue[] = [];
  const output: Record<string, unknown> = {};
  const required = new Set(schema.required ?? []);
  for (const [key, value] of Object.entries(input)) {
    const property = properties[key];
    if (!property || value === undefined || value === null) continue;
    const coerced = matchEnum(value, property);
    const before = issues.length;
    checkValue(coerced, property, [key], issues);
    // An optional value Magica would reject is omitted so the provider can apply its default.
    if (issues.length > before && !required.has(key) && issues.slice(before).every((issue) => issue.message.startsWith("Must be one of"))) {
      issues.length = before;
      continue;
    }
    output[key] = coerced;
  }
  for (const key of schema.required ?? []) {
    if (output[key] === undefined) issues.push({ path: [key], message: "Required" });
  }
  if (issues.length > 0) {
    throw new AppError({
      code: "VALIDATION_ERROR",
      status: 400,
      message: `The model rejected these fields: ${[...new Set(issues.map((issue) => issue.path[0]))].join(", ")}`,
      details: issues,
    });
  }
  return output;
}

function matchEnum(value: unknown, schema: JsonSchema): unknown {
  if (!schema.enum || schema.enum.includes(value) || typeof value !== "string") return value;
  return schema.enum.find((item) => typeof item === "string" && item.toLowerCase() === value.toLowerCase()) ?? value;
}

function checkValue(value: unknown, schema: JsonSchema & { format?: string; minLength?: number; maxLength?: number; nullable?: boolean }, path: string[], issues: Issue[]) {
  if (schema.enum && !schema.enum.includes(value)) {
    issues.push({ path, message: `Must be one of ${schema.enum.map(String).join(", ")}` });
    return;
  }
  switch (schema.type) {
    case "string":
      if (typeof value !== "string") return void issues.push({ path, message: "Must be text" });
      if (schema.minLength !== undefined && value.length < schema.minLength) issues.push({ path, message: `At least ${schema.minLength} characters` });
      if (schema.maxLength !== undefined && value.length > schema.maxLength) issues.push({ path, message: `At most ${schema.maxLength} characters` });
      if (schema.format === "uri" && !/^https?:\/\//.test(value)) issues.push({ path, message: "Must be an http(s) URL" });
      return;
    case "integer":
    case "number":
      if (typeof value !== "number" || Number.isNaN(value)) return void issues.push({ path, message: "Must be a number" });
      if (schema.type === "integer" && !Number.isInteger(value)) issues.push({ path, message: "Must be a whole number" });
      if (schema.minimum !== undefined && value < schema.minimum) issues.push({ path, message: `At least ${schema.minimum}` });
      if (schema.maximum !== undefined && value > schema.maximum) issues.push({ path, message: `At most ${schema.maximum}` });
      return;
    case "boolean":
      if (typeof value !== "boolean") issues.push({ path, message: "Must be true or false" });
      return;
    case "array":
      if (!Array.isArray(value)) return void issues.push({ path, message: "Must be a list" });
      if (schema.minItems !== undefined && value.length < schema.minItems) issues.push({ path, message: `At least ${schema.minItems} items` });
      if (schema.maxItems !== undefined && value.length > schema.maxItems) issues.push({ path, message: `At most ${schema.maxItems} items` });
      if (schema.items) value.forEach((item, index) => checkValue(item, schema.items as JsonSchema, [...path, String(index)], issues));
      return;
    case "object":
      if (!value || typeof value !== "object" || Array.isArray(value)) return void issues.push({ path, message: "Must be an object" });
      for (const [key, child] of Object.entries(schema.properties ?? {})) {
        const nested = (value as Record<string, unknown>)[key];
        if (nested !== undefined && nested !== null) checkValue(nested, child, [...path, key], issues);
      }
      for (const key of schema.required ?? []) {
        if ((value as Record<string, unknown>)[key] === undefined) issues.push({ path: [...path, key], message: "Required" });
      }
      return;
    default:
      return;
  }
}
