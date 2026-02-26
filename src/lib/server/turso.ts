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
let schemaBootstrapPromise: Promise<void> | null = null;
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

async function bootstrapSchema(db: LibSQLDatabase<typeof financeSchema>): Promise<void> {
  await db.run(sql`PRAGMA foreign_keys = ON`);

  await db.run(sql`
    CREATE TABLE IF NOT EXISTS accounts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      kind TEXT NOT NULL,
      provider TEXT NOT NULL CHECK (provider IN ('aib', 'revolut')),
      currency TEXT,
      color TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP)
    )
  `);

  await db.run(sql`
    CREATE TABLE IF NOT EXISTS transactions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      account_id INTEGER NOT NULL,
      source_id TEXT NOT NULL,
      provider TEXT NOT NULL CHECK (provider IN ('aib', 'revolut')),
      booking_date TEXT NOT NULL,
      amount_cents INTEGER NOT NULL,
      currency TEXT NOT NULL,
      direction TEXT NOT NULL CHECK (direction IN ('in', 'out')),
      description TEXT NOT NULL,
      category_hint TEXT,
      counterparty TEXT,
      reference TEXT,
      raw_json TEXT NOT NULL,
      imported_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
      FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE
    )
  `);

  await db.run(sql`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_transactions_account_source_unique
    ON transactions (account_id, source_id)
  `);

  await db.run(sql`
    CREATE INDEX IF NOT EXISTS idx_transactions_account_booking_date
    ON transactions (account_id, booking_date DESC)
  `);

  await db.run(sql`
    CREATE TABLE IF NOT EXISTS transaction_rules (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      description_contains TEXT,
      description_regex TEXT,
      amount_min_cents INTEGER,
      amount_max_cents INTEGER,
      amount_exact_cents INTEGER,
      account_ids_json TEXT,
      apply_category TEXT,
      assign_counterparty_from_regex_group INTEGER NOT NULL DEFAULT 0 CHECK (assign_counterparty_from_regex_group IN (0, 1)),
      priority INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
      updated_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP)
    )
  `);

  await db.run(sql`
    CREATE INDEX IF NOT EXISTS idx_transaction_rules_priority
    ON transaction_rules (priority ASC, id ASC)
  `);
}

export async function resetFinanceSchemaForLocal(): Promise<void> {
  const nodeEnv = process.env.NODE_ENV ?? "development";
  if (nodeEnv === "production") {
    throw new Error("Refusing to reset finance schema in production.");
  }

  const db = getFinanceDb();
  await db.run(sql`PRAGMA foreign_keys = OFF`);
  await db.run(sql`DROP TABLE IF EXISTS transactions`);
  await db.run(sql`DROP TABLE IF EXISTS transaction_rules`);
  await db.run(sql`DROP TABLE IF EXISTS accounts`);
  await db.run(sql`PRAGMA foreign_keys = ON`);

  schemaBootstrapPromise = null;
  await ensureFinanceSchema();
}

export async function ensureFinanceSchema(): Promise<void> {
  if (!schemaBootstrapPromise) {
    schemaBootstrapPromise = bootstrapSchema(getFinanceDb()).catch((error) => {
      schemaBootstrapPromise = null;
      throw error;
    });
  }

  await schemaBootstrapPromise;
}
