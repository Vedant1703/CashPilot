"use client";

// swagger-client needs `OpenApi3_1Element.refract` to be assigned before it
// resolves an OpenAPI 3.1 spec. That assignment is a side-effect of importing
// registration.mjs. The package's exports map only exposes the root entry
// (no deep subpaths), so a direct import of registration.mjs would fail under
// Turbopack's strict exports-map enforcement. resolveAlias in next.config.ts
// maps this specifier to the physical file path, bypassing the restriction.
// A bare import (no named specifiers) cannot be re-export optimized away.
import "@swagger-api/apidom-ns-openapi-3-1/src/refractor/registration.mjs";

import SwaggerUI from "swagger-ui-react";
import "swagger-ui-react/swagger-ui.css";

export function CashPilotSwaggerUi() {
  return <SwaggerUI url="/api/openapi.json" docExpansion="list" displayRequestDuration />;
}
