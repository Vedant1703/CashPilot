/**
 * Validates the OpenAPI contract in src/lib/openapi/document.ts.
 *
 * Checks performed (no network, database or PayPal access):
 *   1. Coverage: every exported HTTP handler under src/app/api/**\/route.ts is
 *      documented, and every documented operation has a handler.
 *   2. Structure: OpenAPI 3.1.x, unique operationIds, declared tags, a 2xx
 *      response per operation, declared path parameters, x-error-codes keyed
 *      by statuses that exist in responses, and resolvable local $refs.
 *   3. Consumption: the spec resolves without errors through swagger-client,
 *      the resolver used by Swagger UI at /api-docs.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { openApiDocument } from "../src/lib/openapi/document";

const API_DIR = join(process.cwd(), "src", "app", "api");
const HTTP_METHODS = ["get", "put", "post", "delete", "options", "head", "patch", "trace"] as const;
const NEXT_HANDLER_NAMES = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"] as const;

type JsonObject = Record<string, unknown>;
type SwaggerClientModule = { default: { resolve: (opts: { spec: unknown }) => Promise<{ errors: unknown[] }> } };

const errors: string[] = [];
const spec = JSON.parse(JSON.stringify(openApiDocument)) as JsonObject;

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function findRouteFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) return findRouteFiles(full);
    return /^route\.(ts|tsx|js|mjs)$/.test(entry) ? [full] : [];
  });
}

/** Maps a Next.js App Router route file to its OpenAPI path template. */
function routeFileToPath(file: string): string {
  const segments = relative(API_DIR, file).split(sep).slice(0, -1);
  const urlSegments = segments
    .filter((segment) => !/^\(.*\)$/.test(segment)) // route groups do not affect the URL
    .map((segment) => {
      if (/^\[\[?\.\.\./.test(segment)) {
        errors.push(`Catch-all route segment "${segment}" in ${file} needs manual mapping in the validator.`);
        return segment;
      }
      const dynamic = /^\[(.+)\]$/.exec(segment);
      return dynamic ? `{${dynamic[1]}}` : segment;
    });
  return `/api/${urlSegments.join("/")}`.replace(/\/$/, "");
}

/** Detects exported Next.js HTTP handlers (function, const or re-export forms). */
function exportedMethods(source: string): string[] {
  const names = new Set<string>();
  const alternatives = NEXT_HANDLER_NAMES.join("|");
  const declaration = new RegExp(`export\\s+(?:async\\s+)?(?:function|const|let|var)\\s+(${alternatives})\\b`, "g");
  for (const match of source.matchAll(declaration)) names.add(match[1]);
  for (const block of source.matchAll(/export\s*\{([^}]*)\}/g)) {
    for (const part of block[1].split(",")) {
      const exported = part.trim().split(/\s+as\s+/).pop()?.trim();
      if (exported && (NEXT_HANDLER_NAMES as readonly string[]).includes(exported)) names.add(exported);
    }
  }
  return [...names].map((name) => name.toLowerCase());
}

function resolvePointer(ref: string): unknown {
  if (!ref.startsWith("#/")) return undefined;
  return ref
    .slice(2)
    .split("/")
    .map((token) => token.replace(/~1/g, "/").replace(/~0/g, "~"))
    .reduce<unknown>((node, token) => (isObject(node) ? node[token] : undefined), spec);
}

function deref(value: unknown): unknown {
  return isObject(value) && typeof value.$ref === "string" ? resolvePointer(value.$ref) : value;
}

function collectRefs(node: unknown, location: string, out: Array<[string, string]>): void {
  if (Array.isArray(node)) node.forEach((item, index) => collectRefs(item, `${location}/${index}`, out));
  else if (isObject(node)) {
    for (const [key, value] of Object.entries(node)) {
      if (key === "$ref" && typeof value === "string") out.push([value, location]);
      else collectRefs(value, `${location}/${key}`, out);
    }
  }
}

// 1. Coverage --------------------------------------------------------------
const implemented = new Set<string>();
for (const file of findRouteFiles(API_DIR)) {
  const path = routeFileToPath(file);
  const methods = exportedMethods(readFileSync(file, "utf8"));
  if (methods.length === 0) errors.push(`No exported HTTP handlers detected in ${relative(process.cwd(), file)}.`);
  for (const method of methods) implemented.add(`${method.toUpperCase()} ${path}`);
}

const paths = isObject(spec.paths) ? spec.paths : {};
const documented = new Set<string>();
for (const [path, item] of Object.entries(paths)) {
  if (!isObject(item)) continue;
  for (const method of HTTP_METHODS) if (isObject(item[method])) documented.add(`${method.toUpperCase()} ${path}`);
}

for (const op of implemented) if (!documented.has(op)) errors.push(`Undocumented operation: ${op}`);
for (const op of documented) if (!implemented.has(op)) errors.push(`Documented operation has no route handler: ${op}`);

// 2. Structure -------------------------------------------------------------
if (typeof spec.openapi !== "string" || !spec.openapi.startsWith("3.1.")) errors.push(`Expected OpenAPI 3.1.x, found ${String(spec.openapi)}.`);
const info = isObject(spec.info) ? spec.info : {};
if (!info.title || !info.version) errors.push("info.title and info.version are required.");

const declaredTags = new Set((Array.isArray(spec.tags) ? spec.tags : []).map((tag) => (isObject(tag) ? tag.name : undefined)));
const operationIds = new Map<string, string>();

for (const [path, item] of Object.entries(paths)) {
  if (!isObject(item)) continue;
  const templateParams = [...path.matchAll(/\{([^}]+)\}/g)].map((match) => match[1]);
  const pathLevelParams = Array.isArray(item.parameters) ? item.parameters : [];

  for (const method of HTTP_METHODS) {
    const op = item[method];
    if (!isObject(op)) continue;
    const label = `${method.toUpperCase()} ${path}`;

    if (typeof op.operationId !== "string") errors.push(`${label}: missing operationId.`);
    else if (operationIds.has(op.operationId)) errors.push(`${label}: duplicate operationId "${op.operationId}" (also ${operationIds.get(op.operationId)}).`);
    else operationIds.set(op.operationId, label);

    for (const tag of Array.isArray(op.tags) ? op.tags : []) {
      if (!declaredTags.has(tag)) errors.push(`${label}: tag "${String(tag)}" is not declared in top-level tags.`);
    }

    const responses = isObject(op.responses) ? op.responses : {};
    if (!Object.keys(responses).some((status) => /^2\d\d$/.test(status))) errors.push(`${label}: no 2xx response documented.`);

    const params = [...pathLevelParams, ...(Array.isArray(op.parameters) ? op.parameters : [])].map(deref).filter(isObject);
    for (const name of templateParams) {
      if (!params.some((param) => param.in === "path" && param.name === name && param.required === true)) {
        errors.push(`${label}: path parameter "{${name}}" is not declared as a required path parameter.`);
      }
    }

    const errorCodes = op["x-error-codes"];
    if (isObject(errorCodes)) {
      for (const status of Object.keys(errorCodes)) {
        if (!(status in responses)) errors.push(`${label}: x-error-codes lists ${status}, which is not a documented response.`);
      }
    }
  }
}

const refs: Array<[string, string]> = [];
collectRefs(spec, "#", refs);
for (const [ref, location] of refs) {
  if (resolvePointer(ref) === undefined) errors.push(`Unresolvable $ref "${ref}" at ${location}.`);
}

// 3. Consumption by Swagger UI's resolver ------------------------------------
async function checkSwaggerResolution(): Promise<void> {
  // swagger-client ships with swagger-ui-react and has no type declarations.
  const specifier = "swagger-client";
  const { default: SwaggerClient } = (await import(specifier)) as SwaggerClientModule;
  const result = await SwaggerClient.resolve({ spec: JSON.parse(JSON.stringify(openApiDocument)) });
  for (const error of result.errors ?? []) errors.push(`swagger-client resolution error: ${JSON.stringify(error)}`);
}

async function main(): Promise<void> {
  await checkSwaggerResolution();

  if (errors.length > 0) {
    console.error(`OpenAPI validation failed with ${errors.length} problem(s):\n- ${errors.join("\n- ")}`);
    process.exit(1);
  }
  console.log(
    `OpenAPI ${String(spec.openapi)} validated: ${documented.size} operations across ${Object.keys(paths).length} paths, ` +
      `matching ${implemented.size} implemented route handlers; ${refs.length} $refs resolved; swagger-client resolution clean.`
  );
}

main().catch((error: unknown) => {
  console.error("OpenAPI validation crashed:", error);
  process.exit(1);
});
