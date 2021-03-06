/* eslint-disable no-unused-vars */
import type { AbortSignal } from "node-abort-controller";

/**
 * Scheduled job handler.
 *
 * @param metadata Metadata about the job
 */
export type ScheduleHandler = (
  metadata: ScheduledJobMetadata & { signal: AbortSignal }
) => Promise<void> | void;

/**
 * Job metadata.
 */
export type ScheduledJobMetadata = {
  /**
   * The job ID. (Unique for your project)
   */
  jobId: string;
  /**
   * The schedule name.
   */
  name: string;
  /**
   * The schedule as cron expression.
   *
   * Use null or "never" to disable the schedule.
   */
  cron: string | "never" | null;
};

/**
 * Export config object to control various aspects of job handling.
 */
export type ScheduleConfig = {
  /**
   * Timeout for processing the job (in seconds)
   *
   * @default 5 minutes
   */
  timeout?: number;
};

export class ScheduledJobError extends Error {
  readonly cause: unknown;
  readonly scheduleName: string;
  readonly jobId: string;

  constructor(
    cause: unknown,
    { jobId, scheduleName }: { jobId: string; scheduleName: string }
  ) {
    super(String(cause));
    this.cause = cause;
    this.jobId = jobId;
    this.scheduleName = scheduleName;
  }

  get stack() {
    return this.cause instanceof Error ? this.cause.stack! : super.stack!;
  }
}

/**
 * Exported from the schedule module.
 */
export type ScheduleExports = {
  default: ScheduleHandler;
  config?: ScheduleConfig;
  schedule: string;
};
