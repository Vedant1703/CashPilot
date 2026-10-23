import { openApiDocument } from "../src/lib/openapi/document";

const requiredPaths = ["/api/invoices/extract", "/api/invoices/draft", "/api/invoices/{id}", "/api/invoices/{id}/approve", "/api/invoices/{id}/paypal-draft", "/api/invoices/{id}/send", "/api/invoices/{id}/remind", "/api/invoices/{id}/cancel", "/api/invoices/{id}/sync"];
const paths = openApiDocument.paths as Record<string, unknown>;
const missing = requiredPaths.filter((path) => !(path in paths));
if (!openApiDocument.openapi.startsWith("3.") || missing.length > 0) throw new Error(`Invalid OpenAPI document. Missing paths: ${missing.join(", ") || "none"}`);
console.log(`OpenAPI ${openApiDocument.openapi} validated with ${Object.keys(paths).length} documented paths.`);
