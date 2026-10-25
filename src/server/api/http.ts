import type { z, ZodTypeAny } from "zod";
import { err, ok, type Result } from "@/lib/result";

/** Framework-free handler results, so API logic is unit-testable without Next. */
export type ApiResponse = { status: number; body: unknown; headers?: Record<string, string> };

export const json = (status: number, body: unknown): ApiResponse => ({ status, body });
export const apiError = (status: number, code: string, message: string): ApiResponse => ({ status, body: { error: { code, message } } });

export function parseBody<S extends ZodTypeAny>(schema: S, body: unknown): Result<z.output<S>, ApiResponse> {
  const r = schema.safeParse(body);
  if (r.success) return ok(r.data as z.output<S>);
  const fields = r.error.issues.map((i) => i.path.join(".") || "body").join(", ");
  return err(apiError(400, "INVALID_INPUT", `Invalid request: ${fields}`));
}

/** Next adapter: turn an ApiResponse into a Response. */
export function toResponse(r: ApiResponse): Response {
  if (typeof r.body === "string") return new Response(r.body, { status: r.status, headers: r.headers });
  return Response.json(r.body, { status: r.status, headers: r.headers });
}

export async function readJson(req: Request): Promise<unknown> {
  try {
    return await req.json();
  } catch {
    return undefined;
  }
}
