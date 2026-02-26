import { fetchRequestHandler } from "@trpc/server/adapters/fetch";
import { appRouter } from "@/server/api/routers/_app";
import { createTRPCContext } from "@/server/api/trpc";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function handler(request: Request): Promise<Response> {
  return fetchRequestHandler({
    endpoint: "/api/trpc",
    req: request,
    router: appRouter,
    createContext: () => createTRPCContext(),
  });
}

export { handler as GET, handler as POST };
