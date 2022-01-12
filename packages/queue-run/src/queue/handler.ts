import chalk from "chalk";
import { AbortController } from "node-abort-controller";
import invariant from "tiny-invariant";
import {
  getLocalStorage,
  loadManifest,
  loadModule,
  LocalStorage,
  logError,
  withLocalStorage,
} from "../shared/index.js";
import { JobMetadata, QueueExports, QueueMiddleware } from "./exports.js";
import { logJobFinished, logJobStarted } from "./middleware.js";

export default async function handleQueuedJob({
  metadata,
  newLocalStorage,
  payload,
  queueName,
  remainingTime,
}: {
  metadata: Omit<JobMetadata, "signal">;
  newLocalStorage: () => LocalStorage;
  payload: string | Buffer | object;
  queueName: string;
  remainingTime: number;
}): Promise<boolean> {
  const { queues } = await loadManifest();
  const queue = queues.get(queueName);
  if (!queue) throw new Error(`No handler for queue ${queueName}`);

  const loaded = await loadModule<QueueExports, QueueMiddleware>(
    `queues/${queueName}.js`,
    {
      onJobStarted: logJobStarted,
      onJobFinished: logJobFinished,
      onError: logError,
    }
  );
  invariant(loaded, "Could not load queue module");

  const { module, middleware } = loaded;

  // When handling FIFO messges, possible we'll run out of time.
  const timeout = Math.min(queue.timeout * 1000, remainingTime);
  if (timeout <= 0) return false;

  // Create an abort controller to allow the handler to cancel incomplete work.
  const controller = new AbortController();
  const abortTimeout = setTimeout(() => controller.abort(), timeout * 1000);
  const { signal } = controller;

  try {
    await Promise.race([
      runWithMiddleware({
        metadata: { ...metadata, signal },
        middleware,
        module,
        newLocalStorage,
        payload,
      }),

      new Promise((resolve) => {
        signal.addEventListener("abort", resolve);
      }),
    ]);
    if (signal.aborted) {
      throw new Error(`Timeout: job took longer than ${timeout}s to process`);
    }
    return true;
  } catch (error) {
    console.error(
      chalk.bold.red('Error in queue "%s" job %s:'),
      queueName,
      metadata.jobID,
      error
    );

    if (middleware.onError) {
      try {
        await middleware.onError(
          error instanceof Error ? error : new Error(String(error)),
          { ...metadata, signal: controller.signal }
        );
      } catch (error) {
        console.error(
          chalk.bold.red('Error in onError handler for queue "%s"'),
          queueName,
          error
        );
      }
    }

    return false;
  } finally {
    clearTimeout(abortTimeout);
    controller.abort();
  }
}

async function runWithMiddleware({
  metadata,
  middleware,
  module,
  newLocalStorage,
  payload,
}: {
  metadata: JobMetadata;
  middleware: QueueMiddleware;
  module: QueueExports;
  newLocalStorage: () => LocalStorage;
  payload: string | Buffer | object;
}) {
  const { signal } = metadata;
  await withLocalStorage(newLocalStorage(), async () => {
    getLocalStorage().user = metadata.user ?? null;

    if (middleware.onJobStarted) await middleware.onJobStarted(metadata);
    if (signal.aborted) return;

    await module.default(payload, metadata);
    if (signal.aborted) return;

    if (middleware.onJobFinished) await middleware.onJobFinished(metadata);
  });
}
