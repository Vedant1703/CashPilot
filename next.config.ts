import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  /* config options here */
  cacheComponents: true,
  partialPrefetching: true,
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
    // Turbopack's re-export optimization resolves named exports like OpenApi3_1Element
    // directly to their source element file (elements/OpenApi3-1.mjs), bypassing
    // registration.mjs whose side-effect assigns `.refract`. The package's exports
    // map does not expose the registration.mjs subpath, so a direct import fails.
    // Using resolveAlias maps the internal deep path to the physical file location,
    // allowing Turbopack to evaluate the module and run its side-effects.
    resolveAlias: {
      "@swagger-api/apidom-ns-openapi-3-1/src/refractor/registration.mjs":
        "./node_modules/@swagger-api/apidom-ns-openapi-3-1/src/refractor/registration.mjs",
    },
  },
};

export default nextConfig;
