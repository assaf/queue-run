import { AbortController } from "node-abort-controller";
import { Request } from "../http/fetch.js";
import { AuthenticatedUser } from "../index.js";
import { loadModule, LocalStorage, withLocalStorage } from "../shared/index.js";
import { loadMiddleware } from "../shared/loadModule.js";
import TimeoutError from "../shared/TimeoutError.js";
import { JSONValue } from "./../json.d";
import {
  WebSocketConfig,
  WebSocketHandler,
  WebSocketMiddleware,
  WebSocketRequest,
} from "./exports.js";
import findRoute from "./findRoute.js";

// eslint-disable-next-line sonarjs/cognitive-complexity
export async function authenticateWebSocket({
  newLocalStorage,
  request,
}: {
  newLocalStorage: () => LocalStorage;
  request: Request;
}): Promise<AuthenticatedUser | null> {
  const { authenticate, onError } = await getCommonMiddleware();
  if (!authenticate) return null;

  return await withLocalStorage(newLocalStorage(), async () => {
    let user;
    try {
      user = await authenticate(request, getCookies(request));
    } catch (error) {
      if (onError) {
        try {
          await onError(
            error instanceof Error ? error : new Error(String(error))
          );
        } catch (error) {
          console.error(error);
        }
      }
      throw new Response("Internal Server Error", { status: 500 });
    }
    if (user === null || user?.id) return user;

    const concern =
      user === undefined
        ? 'Authenticate function returned "undefined", was this intentional?'
        : "Authenticate function returned user object without an ID";
    console.error(concern);
    throw new Response("Forbidden", { status: 403 });
  });
}

function getCookies(request: Request): { [key: string]: string } {
  const header = request.headers.get("cookie");
  if (!header) return {};
  const cookies = header
    .split(";")
    .map((cookie) => cookie.trim())
    .map((cookie) => cookie.match(/^([^=]+?)=(.*)$/)?.slice(1)!)
    .filter(([name]) => name) as [string, string][];

  return cookies.reduce(
    (cookies, [key, value]) => ({ ...cookies, [key]: value }),
    {}
  );
}

async function getCommonMiddleware() {
  const { middleware } =
    (await loadModule<never, WebSocketMiddleware>("socket/index.js", {})) ??
    (await loadMiddleware<WebSocketMiddleware>("socket/_middleware.js", {}));
  return middleware;
}

export async function handleWebSocketMessage({
  connection,
  data,
  newLocalStorage,
  requestId,
  userId,
}: {
  connection: string;
  data: Buffer;
  newLocalStorage: () => LocalStorage;
  requestId: string;
  userId: string | null;
}): Promise<Buffer | null> {
  try {
    let found;
    try {
      found = await findRoute(data);
    } catch (error) {
      const { onError } = await getCommonMiddleware();
      if (onError) {
        await onError(
          error instanceof Error ? error : new Error(String(error))
        );
      }
      return Buffer.from(JSON.stringify({ error: "Not available" }));
    }

    const { middleware, module, route } = found;
    return await handleRoute({
      config: module.config ?? {},
      connection,
      data,
      filename: route.filename,
      handler: module.default,
      middleware,
      newLocalStorage,
      requestId,
      timeout: route.timeout,
      userId,
    });
  } catch (error) {
    console.error("Internal processing error %s", connection, error);
    return Buffer.from(JSON.stringify({ error: String(error) }));
  }
}

async function handleRoute({
  config,
  connection,
  data,
  filename,
  handler,
  middleware,
  newLocalStorage,
  requestId,
  timeout,
  userId,
}: {
  config: WebSocketConfig;
  connection: string;
  data: Buffer;
  filename: string;
  handler: WebSocketHandler;
  middleware: WebSocketMiddleware;
  newLocalStorage: () => LocalStorage;
  requestId: string;
  timeout: number;
  userId: string | null;
}): Promise<Buffer | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout * 1000);

  const metadata = {
    connection,
    requestId,
    signal: controller.signal,
    user: userId ? { id: userId } : null,
  };

  try {
    const localStorage = newLocalStorage();
    localStorage.user = userId ? { id: userId } : null;
    return await withLocalStorage(localStorage, () => {
      localStorage.connection = connection;
      return runWithMiddleware({
        config,
        data,
        handler,
        middleware,
        metadata,
        filename,
      });
    });
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}

async function runWithMiddleware({
  config,
  data,
  filename,
  handler,
  metadata,
  middleware,
}: {
  config: WebSocketConfig;
  data: Buffer;
  filename: string;
  handler: WebSocketHandler;
  metadata: Omit<Parameters<WebSocketHandler>[0], "data">;
  middleware: WebSocketMiddleware;
}): Promise<Buffer | null> {
  const { connection, signal } = metadata;
  const request = { data: bufferToData(data, config), ...metadata };
  try {
    const response = await Promise.race([
      (async () => {
        const { onMessageReceived } = middleware;
        if (onMessageReceived) await onMessageReceived(request);

        return await handler(request);
      })(),

      new Promise<undefined>((resolve) =>
        signal.addEventListener("abort", () => resolve(undefined))
      ),
    ]);

    if (signal.aborted) throw new TimeoutError("Request aborted: timed out");

    if (!response) return null;

    return await handleResponse({
      connection,
      middleware,
      response,
    });
  } catch (error) {
    await handleOnError({
      error,
      filename,
      middleware,
      request: request as WebSocketRequest,
    });

    return await handleResponse({
      connection,
      middleware,
      response: { error: String(error) },
    });
  }
}

function bufferToData(
  data: Buffer,
  config: WebSocketConfig
): JSONValue | string | Buffer {
  switch (config.type ?? "json") {
    case "json":
      return JSON.parse(data.toString("utf-8")) as JSONValue;
    case "text":
      return data.toString("utf-8");
    default:
      return data;
  }
}

async function handleResponse({
  connection,
  middleware,
  response,
}: {
  connection: string;
  middleware: WebSocketMiddleware;
  response: object | string | Buffer | ArrayBuffer;
}): Promise<Buffer | null> {
  const data = await resultToBuffer(response);
  const { onMessageSent } = middleware;
  if (onMessageSent) {
    try {
      await onMessageSent({ connections: [connection], data });
    } catch (error) {
      console.error("Internal processing error in onMessageSent", error);
    }
  }
  return data;
}

async function resultToBuffer(
  result: object | string | Buffer | ArrayBuffer
): Promise<Buffer> {
  if (typeof result === "string") return Buffer.from(result);
  if (result instanceof Buffer) return result;
  if (result instanceof ArrayBuffer) return Buffer.from(result);
  const indent = Number(process.env.QUEUE_RUN_INDENT) || 0;
  return Buffer.from(JSON.stringify(result, null, indent));
}

async function handleOnError({
  error,
  filename,
  middleware,
  request,
}: {
  error: unknown;
  filename: string;
  middleware: WebSocketMiddleware;
  request: WebSocketRequest;
}): Promise<void> {
  if (middleware.onError) {
    try {
      await middleware.onError(
        error instanceof Error ? error : new Error(String(error)),
        request
      );
    } catch (error) {
      console.error('Error in onError middleware in "%s":', filename, error);
    }
  }
}

export async function onMessageSentAsync({
  connections,
  data,
}: {
  connections: string[];
  data: Buffer;
}) {
  const { onMessageSent, onError } = await getCommonMiddleware();
  if (!onMessageSent) return;

  try {
    await onMessageSent({ connections, data });
  } catch (error) {
    if (onError) {
      try {
        await onError(
          error instanceof Error ? error : new Error(String(error))
        );
      } catch (error) {
        console.error("Error in onError middleware", error);
      }
    }
  }
}

export async function handleUserOnline({
  newLocalStorage,
  userId,
}: {
  newLocalStorage: () => LocalStorage;
  userId: string;
}) {
  const { onOnline, onError } = await getCommonMiddleware();
  if (!onOnline) return null;

  return await withLocalStorage(newLocalStorage(), async () => {
    try {
      await onOnline(userId);
    } catch (error) {
      if (onError) {
        try {
          await onError(
            error instanceof Error ? error : new Error(String(error))
          );
        } catch (error) {
          console.error(error);
        }
      }
    }
  });
}

export async function handleUserOffline({
  newLocalStorage,
  userId,
}: {
  newLocalStorage: () => LocalStorage;
  userId: string;
}) {
  const { onOffline, onError } = await getCommonMiddleware();
  if (!onOffline) return null;

  return await withLocalStorage(newLocalStorage(), async () => {
    try {
      await onOffline(userId);
    } catch (error) {
      if (onError) {
        try {
          await onError(
            error instanceof Error ? error : new Error(String(error))
          );
        } catch (error) {
          console.error(error);
        }
      }
    }
  });
}
