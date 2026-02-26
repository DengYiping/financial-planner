import { createTRPCRouter } from "@/server/api/trpc";
import { accountsRouter } from "@/server/api/routers/accounts";

export const appRouter = createTRPCRouter({
  accounts: accountsRouter,
});

export type AppRouter = typeof appRouter;
