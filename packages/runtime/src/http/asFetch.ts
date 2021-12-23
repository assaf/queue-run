import {
  APIGatewayProxyEvent,
  APIGatewayProxyResponse,
  BackendLambdaRequest,
} from "./index";

export async function asFetchRequest(
  event: APIGatewayProxyEvent | BackendLambdaRequest,
  // eslint-disable-next-line no-unused-vars
  handler: (request: Request) => Promise<Response | string | object>
): Promise<APIGatewayProxyResponse> {
  try {
    const response = await handler(toFetchRequest(event));

    if (response instanceof Response) return fromFetchResponse(response);
    if (typeof response === "string" || response instanceof String) {
      return fromFetchResponse(
        new Response(String(response), {
          headers: { "Content-Type": "text/plain" },
        })
      );
    }
    if (response instanceof Buffer) {
      return fromFetchResponse(
        new Response(response, { headers: { "Content-Type": "text/plain" } })
      );
    }
    if (response === null || response === undefined) {
      console.error(
        "HTTP request returned null or undefined. If this was intentional, use this instead: return new Response(null, { status: 204 })"
      );
      return fromFetchResponse(new Response(undefined, { status: 204 }));
    }
    return fromFetchResponse(
      new Response(JSON.stringify(response), {
        headers: { "Content-Type": "application/json" },
      })
    );
  } catch (error) {
    if (error instanceof Response) {
      return fromFetchResponse(
        new Response(error.body, { ...error, status: error.status ?? 500 })
      );
    } else {
      console.error("Callback error", error);
      const message = error instanceof Error ? error.message : String(error);
      return fromFetchResponse(new Response(message, { status: 500 }));
    }
  }
}

function toFetchRequest(
  event: APIGatewayProxyEvent | BackendLambdaRequest
): Request {
  if ("requestContext" in event) {
    const method = event.requestContext.httpMethod;
    const url = `https://${event.requestContext.domainName}${event.requestContext.path}`;
    const headers = new Headers(event.headers);
    const body =
      event.body && event.isBase64Encoded
        ? Buffer.from(event.body, "base64")
        : event.body;
    return new Request(url, { body, headers, method });
  } else {
    const { headers, method, url } = event;
    const hasBody = !["GET", "HEAD"].includes(method);
    const body =
      hasBody && event.body ? Buffer.from(event.body, "base64") : undefined;
    return new Request(url, { body, headers, method });
  }
}

async function fromFetchResponse(
  response: Response
): Promise<APIGatewayProxyResponse> {
  return {
    body: (await response.buffer()).toString("base64"),
    bodyEncoding: "base64",
    headers: Object.fromEntries(response.headers),
    statusCode: response.status ?? 200,
  };
}