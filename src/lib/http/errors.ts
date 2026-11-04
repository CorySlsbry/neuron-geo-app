import { NextResponse } from "next/server";

/**
 * Base class for errors that map to an HTTP response. Domain modules subclass
 * this (e.g. auth-tenancy's AuthError) so the route wrapper can render the
 * envelope without lib depending on any module.
 */
export class HttpError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
  ) {
    super(code);
  }
}

/**
 * Generic error envelope. Server (5xx) responses NEVER leak internals — no
 * stack, no PII, no DB error text. Client (4xx) responses carry a stable
 * machine code the UI can branch on.
 */
export function errorResponse(
  status: number,
  code: string,
  clientMessage?: string,
): NextResponse {
  const message =
    status >= 500
      ? "An unexpected error occurred."
      : (clientMessage ?? code);
  return NextResponse.json({ error: { code, message } }, { status });
}

export const internalError = () => errorResponse(500, "internal_error");
export const unauthorized = () => errorResponse(401, "unauthorized");
export const forbidden = () => errorResponse(403, "forbidden");
export const notFound = () => errorResponse(404, "not_found");
