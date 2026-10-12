import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

function applyCors(request: NextRequest, response: NextResponse): NextResponse {
  const origin = request.headers.get("origin");
  const allowed = process.env.FRONTEND_ORIGIN;
  if (origin && allowed && origin === allowed) {
    response.headers.set("Access-Control-Allow-Origin", origin);
    response.headers.set("Vary", "Origin");
    response.headers.set("Access-Control-Allow-Headers", "Authorization, Content-Type, X-Request-Id");
    response.headers.set("Access-Control-Allow-Methods", "GET, POST, PATCH, DELETE, OPTIONS");
    response.headers.set("Access-Control-Max-Age", "600");
  }
  return response;
}

export function proxy(request: NextRequest) {
  const traceId = request.headers.get("x-request-id") ?? crypto.randomUUID();
  const requestHeaders = new Headers(request.headers);
  requestHeaders.set("x-request-id", traceId);

  if (request.method === "OPTIONS") {
    const response = new NextResponse(null, { status: 204 });
    response.headers.set("x-request-id", traceId);
    return applyCors(request, response);
  }

  const response = NextResponse.next({ request: { headers: requestHeaders } });
  response.headers.set("x-request-id", traceId);
  return applyCors(request, response);
}

export const config = {
  matcher: ["/api/:path*"],
};
