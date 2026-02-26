import "server-only";
import { cache } from "react";
import { appRouter } from "@/server/api/routers/_app";
import { createTRPCContext } from "@/server/api/trpc";

export const getServerTrpcCaller = cache(async () => {
  const context = await createTRPCContext();
  return appRouter.createCaller(context);
});
