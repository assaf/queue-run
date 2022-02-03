import { CloudWatch, Datapoint } from "@aws-sdk/client-cloudwatch";
import { SQS } from "@aws-sdk/client-sqs";
import { URL } from "node:url";
import ora from "ora";
import type { Manifest } from "queue-run";
import invariant from "tiny-invariant";

export async function createQueues({
  prefix,
  queues,
  region,
}: {
  prefix: string;
  queues: Manifest["queues"];
  region: string;
}): Promise<string[]> {
  if (queues.length === 0) return [];

  const sqs = new SQS({ region });
  const queueTimeout = Math.max(
    ...Array.from(queues.values()).map((queue) => queue.timeout * 6)
  );

  const queueNames = queues.map(({ queueName }) => `"${queueName}"`).join(", ");
  const spinner = ora(`Using queues ${queueNames}`).start();

  const arns = await Promise.all(
    queues.map(async ({ queueName }) => {
      // createQueue is idempotent so we can safely call it on each deploy.
      // However, createQueue fails if the queue already exists, but with
      // different attributes, so we split createQueue and setQueueAttributes
      // into two separate calls.
      const isFifo = queueName.endsWith(".fifo");
      const { QueueUrl: queueUrl } = await sqs.createQueue({
        QueueName: `${prefix}${queueName}`,
        Attributes: {
          ...(isFifo
            ? {
                ContentBasedDeduplication: "true",
                DeduplicationScope: "messageGroup",
                FifoQueue: "true",
                FifoThroughputLimit: "perMessageGroupId",
              }
            : undefined),
        },
      });
      if (!queueUrl) throw new Error(`Could not create queue ${queueName}`);

      await sqs.setQueueAttributes({
        QueueUrl: queueUrl,
        Attributes: {
          VisibilityTimeout: queueTimeout.toFixed(0),
        },
      });

      return arnFromQueueURL(queueUrl);
    })
  );
  spinner.succeed();
  return arns;
}

export async function deleteOldQueues({
  prefix,
  queueArns,
  region,
}: {
  prefix: string;
  queueArns: string[];
  region: string;
}) {
  const sqs = new SQS({ region });
  const { QueueUrls: queueUrls } = await sqs.listQueues({
    QueueNamePrefix: prefix,
  });
  if (!queueUrls) return;

  const set = new Set(queueArns);
  const toDelete = queueUrls.filter((url) => !set.has(arnFromQueueURL(url)));
  await Promise.all(
    toDelete.map(async (url) => {
      console.info("µ: Deleting old queue %s", nameFromQueueURL(url));
      await sqs.deleteQueue({ QueueUrl: url });
    })
  );
}

function arnFromQueueURL(queueUrl: string): string {
  // Looks like https://sqs.{region}.amazonaws.com/{accountId}/{queueName}
  const { hostname, pathname } = new URL(queueUrl);
  const region = hostname.match(/^sqs\.(.+?)\.amazonaws\.com/)?.[1];
  const [accountId, name] = pathname.split("/").slice(1);
  return `arn:aws:sqs:${region}:${accountId}:${name}`;
}

function nameFromQueueURL(queueUrl: string): string {
  // Looks like https://sqs.{region}.amazonaws.com/{accountId}/{queueName}
  const { pathname } = new URL(queueUrl);
  const queueName = pathname.split("/")[2];
  invariant(queueName, "Incorrectly formatted queue URL");
  return queueName;
}

export async function listQueues({
  // Count messages for time time period (ms)
  period,
  project,
  region,
}: {
  period: number;
  project: string;
  region: string;
}) {
  const sqs = new SQS({ region });
  const prefix = `qr-${project}__`;
  const { QueueUrls: queueUrls } = await sqs.listQueues({
    QueueNamePrefix: prefix,
  });
  if (!queueUrls) return [];

  const cloudWatch = new CloudWatch({ region });
  const end = new Date();
  const start = new Date(end.getTime() - period);

  return await Promise.all(
    queueUrls.map(async (url) => {
      const queueName = nameFromQueueURL(url);
      const [queued, inFlight, processed, oldest] = await Promise.all([
        getMetric({
          aggregate: "Sum",
          cloudWatch,
          end,
          metricName: "NumberOfMessagesSent",
          queueName,
          start,
        }),
        getMetric({
          aggregate: "Maximum",
          cloudWatch,
          end,
          metricName: "ApproximateNumberOfMessagesNotVisible",
          queueName,
          start,
        }),
        getMetric({
          aggregate: "Sum",
          cloudWatch,
          end,
          metricName: "NumberOfMessagesDeleted",
          queueName,
          start,
        }),
        getMetric({
          aggregate: "Maximum",
          cloudWatch,
          end,
          metricName: "ApproximateAgeOfOldestMessage",
          queueName,
          start,
        }),
      ]);
      return {
        queueName: queueName.replace(prefix, ""),
        queued,
        inFlight,
        processed,
        oldest,
      };
    })
  );
}

async function getMetric({
  aggregate,
  end,
  cloudWatch,
  metricName,
  queueName,
  start,
}: {
  aggregate: keyof Datapoint;
  end: Date;
  cloudWatch: CloudWatch;
  metricName: string;
  queueName: string;
  start: Date;
}) {
  const { Datapoints } = await cloudWatch.getMetricStatistics({
    Dimensions: [{ Name: "QueueName", Value: queueName }],
    EndTime: end,
    MetricName: metricName,
    Namespace: "AWS/SQS",
    Period: end.getTime() - start.getTime(),
    StartTime: start,
    Statistics: ["Sum", "Maximum"],
  });
  return Datapoints?.[0]?.[aggregate!];
}
