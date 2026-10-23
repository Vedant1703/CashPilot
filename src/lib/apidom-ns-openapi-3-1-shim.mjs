/**
 * Shim for @swagger-api/apidom-ns-openapi-3-1
 *
 * Turbopack's re-export optimization can resolve named exports like
 * `OpenApi3_1Element` directly to their source file (elements/OpenApi3-1.mjs),
 * bypassing registration.mjs. registration.mjs is the module that assigns the
 * static `.refract()` method to each element class as a side-effect.
 *
 * This shim explicitly re-exports from registration.mjs first (forcing its
 * side-effects to run) and then re-exports everything else from the package root.
 * By aliasing the entire package to this shim, Turbopack cannot skip the
 * registration step regardless of how it optimizes named re-exports.
 */

// Side-effect: assigns .refract to all element classes.
// This import uses the resolveAlias path in next.config.ts.
export * from "@swagger-api/apidom-ns-openapi-3-1/src/refractor/registration.mjs";

// Re-export everything else from the package root (namespace, media types,
// predicates, visitors, refractor plugins, toolbox, etc.).
export * from "@swagger-api/apidom-ns-openapi-3-1/src/index.mjs";
export { default } from "@swagger-api/apidom-ns-openapi-3-1/src/index.mjs";
