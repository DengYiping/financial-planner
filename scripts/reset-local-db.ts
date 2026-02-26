import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createClient } from "@libsql/client";

type TursoConfig = {
  url: string;
  authToken?: string;
};

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
      "Missing Turso database URL. Set TURSO_DATABASE_URL (or DATABASE_URL) for local reset."
    );
  }

  return authToken ? { url, authToken } : { url };
}

async function main(): Promise<void> {
  const nodeEnv = process.env.NODE_ENV ?? "development";
  if (nodeEnv === "production") {
    throw new Error("Refusing to reset schema in production.");
  }

  const client = createClient(readTursoConfig());

  await client.execute("PRAGMA foreign_keys = OFF");
  await client.execute("DROP TABLE IF EXISTS transactions");
  await client.execute("DROP TABLE IF EXISTS accounts");
  await client.execute("PRAGMA foreign_keys = ON");
  process.stdout.write("Local finance tables dropped.\n");
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : "Unknown error";
  process.stderr.write(`Failed to reset local finance schema: ${message}\n`);
  process.exit(1);
});
