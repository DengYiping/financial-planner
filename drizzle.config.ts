import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { defineConfig } from "drizzle-kit";

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

if (!process.env.TURSO_DATABASE_URL && !process.env.DATABASE_URL) {
  loadLocalVercelEnvFallback();
}

const tursoUrl = process.env.TURSO_DATABASE_URL ?? process.env.DATABASE_URL;
if (!tursoUrl) {
  throw new Error(
    "Missing Turso database URL. Set TURSO_DATABASE_URL (or DATABASE_URL) for drizzle-kit commands."
  );
}

export default defineConfig({
  schema: "./src/lib/server/db/schema.ts",
  out: "./drizzle",
  dialect: "turso",
  dbCredentials: {
    url: tursoUrl,
    authToken: process.env.TURSO_AUTH_TOKEN ?? process.env.DATABASE_AUTH_TOKEN,
  },
  strict: true,
  verbose: true,
});
