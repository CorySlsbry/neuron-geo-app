import { NextResponse } from "next/server";
import { errorResponse, HttpError, internalError } from "./errors";

/**
 * Wraps a route handler with the standard error envelope: HttpError → its
 * status/code; anything else → generic 500 (never leaks internals).
 */
export function route<A extends unknown[]>(
  handler: (...args: A) => Promise<NextResponse>,
): (...args: A) => Promise<NextResponse> {
  return async (...args: A) => {
    try {
      return await handler(...args);
    } catch (err) {
      if (err instanceof HttpError) {
        return errorResponse(err.status, err.code);
      }
      console.error(err); // server log only — client gets the generic envelope
      return internalError();
    }
  };
}
