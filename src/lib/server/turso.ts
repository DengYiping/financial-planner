import "server-only";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createClient, type Client } from "@libsql/client";
import { sql } from "drizzle-orm";
import { drizzle, type LibSQLDatabase } from "drizzle-orm/libsql";
import * as financeSchema from "@/lib/server/db/schema";

type TursoConfig = {
  url: string;
  authToken?: string;
};

let tursoClient: Client | null = null;
let financeDb: LibSQLDatabase<typeof financeSchema> | null = null;
let localEnvLoadAttempted = false;

function parseEnvFile(content: string): Record<string, string> {
  const parsed: Record<string, string> = {};

  content.split(/\r?\n/).forEach((line) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      return;
    }

    const separatorIndex = trimmed.indexOf("=");
    if (separatorIndex <= 0) {
      return;
    }

    const key = trimmed.slice(0, separatorIndex).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
      return;
    }

    let value = trimmed.slice(separatorIndex + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    parsed[key] = value;
  });

  return parsed;
}

function loadLocalVercelEnvFallback(): void {
  if (localEnvLoadAttempted) {
    return;
  }
  localEnvLoadAttempted = true;

  const nodeEnv = process.env.NODE_ENV ?? "development";
  const candidatePaths = [
    join(process.cwd(), ".vercel", `.env.${nodeEnv}.local`),
    join(process.cwd(), ".vercel", ".env.development.local"),
    join(process.cwd(), ".vercel", ".env.local"),
  ];

  candidatePaths.forEach((filePath) => {
    if (!existsSync(filePath)) {
      return;
    }

    const fileContent = readFileSync(filePath, "utf8");
    const entries = parseEnvFile(fileContent);
    Object.entries(entries).forEach(([key, value]) => {
      if (typeof process.env[key] === "undefined") {
        process.env[key] = value;
      }
    });
  });
}

function readTursoConfig(): TursoConfig {
  let url = process.env.TURSO_DATABASE_URL ?? process.env.DATABASE_URL;
  let authToken = process.env.TURSO_AUTH_TOKEN ?? process.env.DATABASE_AUTH_TOKEN;

  if (!url || !authToken) {
    loadLocalVercelEnvFallback();
    url = process.env.TURSO_DATABASE_URL ?? process.env.DATABASE_URL;
    authToken = process.env.TURSO_AUTH_TOKEN ?? process.env.DATABASE_AUTH_TOKEN;
  }

  if (!url) {
    throw new Error(
      "Missing Turso database URL. Set TURSO_DATABASE_URL (or DATABASE_URL) for server-side persistence."
    );
  }

  return authToken ? { url, authToken } : { url };
}

export function getTursoClient(): Client {
  if (!tursoClient) {
    tursoClient = createClient(readTursoConfig());
  }

  return tursoClient;
}

export function getFinanceDb(): LibSQLDatabase<typeof financeSchema> {
  if (!financeDb) {
    financeDb = drizzle(getTursoClient(), {
      schema: financeSchema,
    });
  }

  return financeDb;
}

export async function resetFinanceSchemaForLocal(): Promise<void> {
  const nodeEnv = process.env.NODE_ENV ?? "development";
  if (nodeEnv === "production") {
    throw new Error("Refusing to reset finance schema in production.");
  }

  const db = getFinanceDb();
  await db.run(sql`PRAGMA foreign_keys = OFF`);
  await db.run(sql`DROP TABLE IF EXISTS transaction_tags`);
  await db.run(sql`DROP TABLE IF EXISTS transaction_rule_tags`);
  await db.run(sql`DROP TABLE IF EXISTS transactions`);
  await db.run(sql`DROP TABLE IF EXISTS transaction_rules`);
  await db.run(sql`DROP TABLE IF EXISTS tags`);
  await db.run(sql`DROP TABLE IF EXISTS categories`);
  await db.run(sql`DROP TABLE IF EXISTS accounts`);
  await db.run(sql`DROP TABLE IF EXISTS __drizzle_migrations`);
  await db.run(sql`PRAGMA foreign_keys = ON`);
}
