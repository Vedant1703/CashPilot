declare module "swagger-ui-react" {
  import type { ComponentType } from "react";

  interface SwaggerUiProps {
    url?: string;
    docExpansion?: "none" | "list" | "full";
    displayRequestDuration?: boolean;
  }

  const SwaggerUI: ComponentType<SwaggerUiProps>;
  export default SwaggerUI;
}
