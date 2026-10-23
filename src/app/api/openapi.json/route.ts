import { NextResponse } from "next/server";
import { openApiDocument } from "@/lib/openapi/document";

/** Read-only OpenAPI contract. It performs no database or PayPal calls. */
export async function GET() {
  return NextResponse.json(openApiDocument, { headers: { "Cache-Control": "no-store" } });
}
