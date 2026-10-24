import type { Metadata } from "next";
import { CashPilotSwaggerUi } from "@/components/api-docs/swagger-ui";

export const metadata: Metadata = { title: "API Documentation | CashPilot", description: "Interactive OpenAPI documentation for the CashPilot API." };

export default function ApiDocsPage() {
  return <main className="min-h-screen bg-[#F6F5F1] px-4 py-6 sm:px-6"><div className="mx-auto mb-5 max-w-7xl rounded-2xl border border-[#E3E8EF] bg-white p-5 shadow-xs"><h1 className="font-headline text-2xl font-bold text-[#12263F]">CashPilot API</h1><p className="mt-1 text-sm text-[#5E718D]">Interactive local documentation. PayPal-labelled operations can contact Sandbox only when you explicitly execute them.</p></div><div className="mx-auto max-w-7xl overflow-hidden rounded-2xl bg-white p-2 shadow-xs"><CashPilotSwaggerUi /></div></main>;
}
