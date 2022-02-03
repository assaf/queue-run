import { CloudWatch } from "@aws-sdk/client-cloudwatch";
import { CloudWatchEvents } from "@aws-sdk/client-cloudwatch-events";
import { Lambda } from "@aws-sdk/client-lambda";
import cronParser from "cron-parser";
import ora from "ora";
import { ScheduledJob } from "queue-run";

export async function updateSchedules({
  lambdaArn,
  region,
  schedules,
}: {
  lambdaArn: string;
  region: string;
  schedules: ScheduledJob[];
}) {
  const spinner = ora("Updating schedules").start();
  const events = new CloudWatchEvents({ region });
  const lambda = new Lambda({ region });
  await Promise.all(
    schedules.map((schedule) =>
      updateSchedule({
        events,
        lambda,
        lambdaArn,
        schedule,
      })
    )
  );
  spinner.succeed(`Updated ${schedules.length} schedules`);
}

async function updateSchedule({
  events,
  lambda,
  lambdaArn,
  schedule,
}: {
  events: CloudWatchEvents;
  lambda: Lambda;
  lambdaArn: string;
  schedule: ScheduledJob;
}) {
  const [region, accountId, lambdaName] = lambdaArn
    .match(/arn:aws:lambda:(.*):(.*):function:(.*):/)!
    .slice(1);
  const ruleName = `${lambdaName}.${schedule.name}`;
  await events.putRule({
    Name: ruleName,
    ScheduleExpression: `cron(${toCloudWatchCronExpression(schedule.cron)})`,
    State: "ENABLED",
  });
  await events.putTargets({
    Rule: ruleName,
    Targets: [{ Id: "lambda", Arn: lambdaArn }],
  });

  try {
    await lambda.addPermission({
      Action: "lambda:InvokeFunction",
      FunctionName: lambdaArn,
      Principal: "events.amazonaws.com",
      SourceArn: `arn:aws:events:${region}:${accountId}:rule/${ruleName}`,
      StatementId: ruleName.replace(/\./g, "__"),
    });
  } catch (error) {
    if (!(error instanceof Error && error.name === "ResourceConflictException"))
      throw error;
  }
}

// cron is typically second, minute … day of week
// AWS cron is minute, hour … year
function toCloudWatchCronExpression(cron: string) {
  const parsed = cronParser.parseExpression(cron, { iterator: false });
  // Drop seconds
  const [minute, hour, dayOfMonth, month, dayOfWeek] = parsed
    .stringify(false)
    .split(" ");

  return [
    minute,
    hour,
    dayOfMonth,
    month,
    dayOfWeek === "*" && dayOfMonth === "*" ? "?" : dayOfWeek,
    "*",
  ].join(" ");
}

export async function removeUnusedSchedules({
  region,
  lambdaArn,
  schedules,
}: {
  lambdaArn: string;
  region: string;
  schedules: Set<string>;
}) {
  const spinner = ora("Removing old schedules").start();
  const [lambdaName] = lambdaArn.match(/([^:]+):([^:]+)$/)!.slice(1);
  const prefix = `${lambdaName}.`;
  const events = new CloudWatchEvents({ region });
  const ruleNames = await getRuleNames({ events, lambdaArn });
  const unused = ruleNames
    .filter((name) => name.startsWith(prefix))
    .filter((name) => !schedules.has(name.slice(prefix.length)));
  await Promise.all(
    unused.map(async (name) => {
      await events.removeTargets({ Ids: ["lambda"], Rule: name });
      await events.deleteRule({ Name: name });
    })
  );
  spinner.succeed(`Removed ${unused.length} old schedules`);
}

async function getRuleNames({
  events,
  lambdaArn,
  nextToken,
}: {
  events: CloudWatchEvents;
  lambdaArn: string;
  nextToken?: string | undefined;
}): Promise<string[]> {
  const { RuleNames, NextToken } = await events.listRuleNamesByTarget({
    TargetArn: lambdaArn,
    ...(nextToken && { NextToken: nextToken }),
  });
  if (!RuleNames) return [];
  if (!NextToken) return RuleNames;
  const next = await getRuleNames({ events, lambdaArn, nextToken: NextToken });
  return RuleNames.concat(next);
}

export async function listSchedules({
  lambdaArn,
}: {
  lambdaArn: string;
}): Promise<
  Array<{
    name: string;
    cron: string;
    next: Date;
    count: number;
  }>
> {
  const region = lambdaArn.match(/arn:aws:lambda:(.*?):/)![1]!;
  const events = new CloudWatchEvents({ region });
  const ruleNames = await getRuleNames({ events, lambdaArn });

  const cloudWatch = new CloudWatch({ region });
  const period = 60 * 60 * 24; // 1 day

  const rules = await Promise.all(
    ruleNames.map((ruleName) =>
      Promise.all([
        events.describeRule({ Name: ruleName }),
        cloudWatch.getMetricStatistics({
          EndTime: new Date(),
          Namespace: "AWS/Events",
          MetricName: "TriggeredRules",
          Period: period,
          StartTime: new Date(new Date().getTime() - period * 1000),
          Statistics: ["Sum"],
          Dimensions: [{ Name: "RuleName", Value: ruleName }],
        }),
      ])
    )
  );

  return rules
    .filter(([rule]) => rule.State === "ENABLED")
    .map(([rule, metric]) => ({
      name: rule.Name!.split(".")[1]!,
      cron: toRegularCron(rule.ScheduleExpression),
      count: metric.Datapoints?.[0]?.Sum ?? 0,
    }))
    .filter(({ cron }) => !!cron)
    .map(({ name, cron, count }) => ({
      name,
      cron: cron!,
      next: cronParser.parseExpression(cron!).next().toDate(),
      count,
    }));
}

function toRegularCron(scheduleExpression: string | undefined) {
  return scheduleExpression
    ?.match(/cron\((.*)\)/)?.[1]
    ?.replace(/\?/g, "*")
    .replace(/ \*$/g, "");
}