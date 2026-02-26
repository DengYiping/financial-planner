import "server-only";
import { NextResponse } from "next/server";

type ApiErrorPayload = {
  error: {
    code: string;
    message: string;
    details?: unknown;
  };
};

export function jsonError(status: number, code: string, message: string, details?: unknown): NextResponse {
  const payload: ApiErrorPayload = details
    ? { error: { code, message, details } }
    : { error: { code, message } };

  return NextResponse.json(payload, { status });
}

export async function readJsonBody(request: Request): Promise<
  | {
      ok: true;
      value: unknown;
    }
  | {
      ok: false;
      message: string;
    }
> {
  try {
    const value = await request.json();
    return { ok: true, value };
  } catch {
    return { ok: false, message: "Request body must be valid JSON." };
  }
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

