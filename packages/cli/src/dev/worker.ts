import ms from "ms";
import { createServer, IncomingMessage, ServerResponse } from "node:http";
import path from "node:path";
import process from "node:process";
import { Duplex } from "node:stream";
import { URL } from "node:url";
import {
  handleHTTPRequest,
  handleQueuedJob,
  handleScheduledJob,
  handleWebSocketConnect,
  handleWebSocketMessage,
  Headers,
  loadManifest,
  NewExecutionContext,
  socket,
  url,
  warmup,
} from "queue-run";
import { buildProject } from "queue-run-builder";
import invariant from "tiny-invariant";
import { WebSocket, WebSocketServer } from "ws";
import {
  DevExecutionContext,
  getUser as getUserId,
  onWebSocketAccepted,
  onWebSocketClosed,
} from "./dev_context.js";

const sourceDir = process.cwd();
const buildDir = path.resolve(".queue-run");

export default async function worker() {
  url.baseUrl = process.env.QUEUE_RUN_URL;
  socket.url = process.env.QUEUE_RUN_WS;
  const port = process.env.QUEUE_RUN_URL.split(":")[2];

  const ready = (async () => {
    await buildProject({ buildDir, sourceDir });
    process.send!("ready");

    process.chdir(buildDir);

    await warmup((args) => new DevExecutionContext(args));
  })();

  const ws = new WebSocketServer({ noServer: true });
  const http = createServer()
    .on("request", async (req, res) => {
      await ready;
      onRequest(req, res, (args) => new DevExecutionContext(args));
    })
    .on("upgrade", async (req, socket, head) => {
      await ready;
      onUpgrade(req, socket, head, ws, (args) => new DevExecutionContext(args));
    })
    .listen(port);

  process.on("disconnect", function () {
    http.close();
    ws.close();
  });

  // Make sure we exit if buildProject fails
  ready.catch((error) => {
    console.error("💥 Build failed!", error);
    process.exit(1);
  });
}

async function onRequest(
  req: IncomingMessage,
  res: ServerResponse,
  newExecutionContext: NewExecutionContext
) {
  if (req.url?.startsWith("/$queues/"))
    return queueJob(req, res, newExecutionContext);

  if (req.url?.startsWith("/$schedules/"))
    return scheduleJob(req, res, newExecutionContext);

  const method = req.method?.toLocaleUpperCase() ?? "GET";
  const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
  const headers = new Headers(
    Object.fromEntries(
      Object.entries(req.headers).map(([name, value]) => [name, String(value)])
    )
  );
  headers.set("X-Forwarded-For", req.socket?.remoteAddress ?? "unknown");
  const body = await getRequestBody(req);
  const request = new Request(url.href, {
    method,
    headers,
    body,
  });

  const response = await handleHTTPRequest({
    newExecutionContext,
    request,
    requestId: crypto.randomUUID!(),
  });
  const resHeaders: Record<string, string> = {};
  response.headers.forEach((value, name) => (resHeaders[name] = value));
  res.writeHead(response.status, resHeaders);
  const buffer = await response.arrayBuffer();
  res.end(Buffer.from(buffer));
}

async function getRequestBody(req: IncomingMessage): Promise<Buffer | null> {
  const hasBody = req.method !== "GET" && req.method !== "HEAD";
  if (!hasBody) return null;
  let data: Buffer[] = [];
  for await (const chunk of req) data.push(chunk);
  return Buffer.concat(data);
}

async function queueJob(
  req: IncomingMessage,
  res: ServerResponse,
  newExecutionContext: NewExecutionContext
) {
  if (req.method !== "POST") {
    res.writeHead(405, "Method not allowed").end();
    return;
  }

  let payload;
  let data: Buffer[] = [];
  for await (const chunk of req) data.push(chunk);
  payload = Buffer.concat(data).toString("utf-8");
  try {
    payload = JSON.parse(payload);
  } catch {
    // Ignore
  }

  const [queueName, groupId] = req.url!.split("/").slice(2);
  invariant(queueName, "Queue name is required");

  const hasQueue = (await loadManifest()).queues.get(queueName);
  if (!hasQueue) {
    res.writeHead(404, "Not Found").end();
    return;
  }

  res.writeHead(202, "Accepted").end();
  try {
    await handleQueuedJob({
      metadata: {
        queueName,
        groupId,
        jobId: crypto.randomUUID!(),
        params: {},
        receivedCount: 1,
        queuedAt: new Date(),
        sequenceNumber: groupId ? 1 : undefined,
        user: null,
      },
      newExecutionContext,
      payload,
      queueName,
      remainingTime: ms("30s"),
    });
  } catch (error) {
    console.error("💥 Queue job failed!", error);
  }
}

async function scheduleJob(
  req: IncomingMessage,
  res: ServerResponse,
  newExecutionContext: NewExecutionContext
) {
  if (req.method !== "POST") {
    res.writeHead(405, "Method not allowed").end();
    return;
  }

  const [name] = req.url!.split("/").slice(2);
  invariant(name, "Schedule name is required");
  const hasSchedule = (await loadManifest()).schedules.get(name);
  if (!hasSchedule) {
    res.writeHead(404, "Not Found").end();
    return;
  }

  res.writeHead(202, "Accepted").end();
  try {
    await handleScheduledJob({
      jobId: crypto.randomUUID!(),
      name,
      newExecutionContext,
    });
  } catch (error) {
    console.error("💥 Scheduled job failed!", error);
  }
}

async function onUpgrade(
  req: IncomingMessage,
  socket: Duplex,
  head: Buffer,
  wss: WebSocketServer,
  newExecutionContext: NewExecutionContext
) {
  try {
    const request = new Request(
      new URL(req.url ?? "/", `http://${req.headers.host}`).href,
      {
        method: req.method ?? "GET",
        headers: Object.fromEntries(
          Object.entries(req.headers).map(([name, value]) => [
            name,
            String(value),
          ])
        ),
      }
    );

    const connectionId = req.headers["sec-websocket-key"]!;
    const response = await handleWebSocketConnect({
      connectionId,
      request,
      requestId: crypto.randomUUID!(),
      newExecutionContext,
    });

    if (response.status > 299) {
      console.info("   Authentication rejected: %d", response.status);
      socket.write(
        `HTTP/1.1 ${response.status} ${await response.text()}\r\n\r\n`
      );
      socket.destroy();
      return;
    }

    wss.handleUpgrade(req, socket, head, (socket) =>
      onConnection({
        connectionId,
        newExecutionContext,
        socket,
      })
    );
  } catch (error) {
    console.error("💥 Authentication failed!");
    socket.write("HTTP/1.1 500 Internal Server Error\r\n\r\n");
    socket.destroy();
  }
}

async function onConnection({
  connectionId,
  newExecutionContext,
  socket,
}: {
  connectionId: string;
  newExecutionContext: NewExecutionContext;
  socket: WebSocket;
}) {
  onWebSocketAccepted({ connection: connectionId, socket });

  socket.on("message", async (rawData) => {
    const data =
      rawData instanceof ArrayBuffer
        ? Buffer.from(rawData)
        : Array.isArray(rawData)
        ? Buffer.concat(rawData)
        : rawData;
    try {
      await handleWebSocketMessage({
        connectionId,
        data,
        newExecutionContext,
        requestId: crypto.randomUUID!(),
        userId: getUserId(connectionId),
      });
    } catch (error) {
      socket.send(JSON.stringify({ error: String(error) }), {
        binary: false,
      });
    }
  });
  socket.on("close", () =>
    onWebSocketClosed({
      connectionId,
      newExecutionContext,
    })
  );
}
