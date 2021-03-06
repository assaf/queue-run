import {
  CloudFormation,
  CreateStackInput,
  StackEvent,
} from "@aws-sdk/client-cloudformation";
import { writeFile } from "node:fs/promises";
import ora, { Ora } from "ora";
import invariant from "tiny-invariant";
import displayTable from "../display_table.js";

const cloudFormation = new CloudFormation({});

export async function deployStack({
  changeSetFilename,
  signal,
  stack,
}: {
  changeSetFilename?: string;
  signal?: AbortSignal;
  stack: CreateStackInput;
}) {
  const stackName = stack.StackName!;
  const requestToken = crypto.randomUUID!();

  function cancel() {
    cloudFormation.cancelUpdateStack({ StackName: stackName });
  }

  let successful;
  const spinner = ora(`Deploying stack ${stackName}`).start();
  try {
    const existing = await findStack(stackName);
    const initialStatus = existing?.StackStatus;
    if (initialStatus?.endsWith("_IN_PROGRESS"))
      throw new Error(`Stack ${stackName} is currently updating`);
    let isCreating = !existing;

    if (
      initialStatus === "ROLLBACK_COMPLETE" ||
      initialStatus === "DELETE_FAILED"
    ) {
      spinner.text = "Previous deploy failed, deleting old stack …";
      await recoverFromFailedDeploy(existing!.StackId!);
      isCreating = true;
    }

    spinner.text = "Reviewing stack changes …";
    const changeSetId = await useChangeSet({
      changeSetFilename,
      isCreating,
      requestToken,
      stack: stack,
    });
    if (signal?.aborted) throw new Error("Deployment cancelled");
    signal?.addEventListener("abort", cancel);

    if (!changeSetId) {
      spinner.succeed("No stack changes to deploy");
      return null;
    }

    const events = await waitForStackUpdate(stackName, requestToken, spinner);
    const finalStatus = (await findStack(stackName))?.StackStatus;
    successful =
      finalStatus === "UPDATE_COMPLETE" || finalStatus === "CREATE_COMPLETE";
    if (successful) {
      spinner.succeed();
      displayEvents(events, requestToken, [
        "CREATE_COMPLETE",
        "UPDATE_COMPLETE",
        "DELETE_COMPLETE",
      ]);
    } else {
      spinner.fail("Stack deploy failed, see details below:");
      displayEvents(events, requestToken, [
        "CREATE_FAILED",
        "UPDATE_FAILED",
        "DELETE_FAILED",
      ]);
      throw new Error("Stack deploy failed");
    }
    return changeSetId;
  } catch (error) {
    spinner.fail();
    throw error;
  } finally {
    signal?.removeEventListener("abort", cancel);
  }
}

async function recoverFromFailedDeploy(existingId: string) {
  await cloudFormation.deleteStack({ StackName: existingId });
  while ((await findStack(existingId))?.StackStatus?.endsWith("_IN_PROGRESS"))
    await new Promise((resolve) => setTimeout(resolve, 500));
}

async function useChangeSet({
  changeSetFilename,
  stack,
  isCreating,
  requestToken,
}: {
  changeSetFilename?: string;
  stack: CreateStackInput;
  isCreating: boolean;
  requestToken: string;
}): Promise<string | null> {
  const { Id: changeSetId } = await cloudFormation.createChangeSet({
    ChangeSetName: `qr-${crypto.randomUUID!()}`,
    ChangeSetType: isCreating ? "CREATE" : "UPDATE",
    ...stack,
  });
  invariant(changeSetId);

  do {
    const {
      Changes: changes,
      Status: status,
      StatusReason: reason,
    } = await cloudFormation.describeChangeSet({ ChangeSetName: changeSetId });

    if (status === "CREATE_COMPLETE") {
      if (changeSetFilename)
        await writeFile(changeSetFilename, JSON.stringify(changes, null, 2));
      await cloudFormation.executeChangeSet({
        ChangeSetName: changeSetId,
        ClientRequestToken: requestToken,
      });
      return changeSetId;
    }

    if (status === "FAILED") {
      await cloudFormation.deleteChangeSet({ ChangeSetName: changeSetId });
      if (changes?.length === 0) return null;
      else throw new Error(reason ?? "Can't create changeset");
    }

    await new Promise((resolve) => setTimeout(resolve, 500));
    // eslint-disable-next-line no-constant-condition
  } while (true);
}

export async function deleteStack(stackName: string) {
  const cloudFormation = new CloudFormation({});
  const spinner = ora(`Deleting stack ${stackName}`).start();
  try {
    const stack = await findStack(stackName);
    if (!stack) {
      spinner.succeed();
      return;
    }
    const stackId = stack.StackId;
    invariant(stackId);
    await cloudFormation.updateTerminationProtection({
      EnableTerminationProtection: false,
      StackName: stackId,
    });
    const requestToken = crypto.randomUUID!();
    await cloudFormation.deleteStack({
      StackName: stackId,
      ClientRequestToken: requestToken,
    });
    const events = await waitForStackUpdate(stackId, requestToken, spinner);
    spinner.succeed();
    displayEvents(events, requestToken, ["DELETE_COMPLETE", "DELETE_FAILED"]);
  } catch (error) {
    spinner.fail();
    throw error;
  }
}

export async function getStackStatus(lambdaName: string) {
  try {
    const stack = await findStack(lambdaName);
    return stack?.StackStatus ?? "Not found";
  } catch (error) {
    return "Error";
  }
}

export async function findStack(stackName: string) {
  try {
    const { Stacks } = await cloudFormation.describeStacks({
      StackName: stackName,
    });
    const stack = Stacks?.[0];
    invariant(stack);
    return stack;
  } catch (error) {
    if (
      typeof error === "object" &&
      (error as { Code: string }).Code === "ValidationError"
    )
      return null;
    else throw error;
  }
}

async function waitForStackUpdate(
  stackId: string,
  token: string,
  spinner: Ora
) {
  let inProgress = true;
  let events;
  do {
    await new Promise((resolve) => setTimeout(resolve, 500));
    const stacks = await cloudFormation.describeStacks({ StackName: stackId });
    const stack = stacks.Stacks?.[0];
    inProgress = stack?.StackStatus?.endsWith("_IN_PROGRESS") ?? false;
    events = (
      await cloudFormation.describeStackEvents({
        StackName: stackId,
      })
    ).StackEvents;
    const event = events?.filter(
      (event) => event.ClientRequestToken === token
    )[0];
    if (event)
      spinner.text = `${event.LogicalResourceId} → ${formatStatus(
        event.ResourceStatus
      )}`;
  } while (inProgress);
  return events ?? [];
}

function displayEvents(
  events: StackEvent[],
  token: string,
  statuses: string[]
) {
  events = events
    .filter((event) => event.ClientRequestToken === token)
    .filter((event) => statuses.includes(event.ResourceStatus!));
  if (events.length === 0) return;

  displayTable({
    headers: ["Resource", "Status"],
    rows: events.map((event) => [
      event.LogicalResourceId,
      event.ResourceStatusReason ?? formatStatus(event.ResourceStatus),
    ]),
    options: { wrapCells: true },
  });
}

function formatStatus(status: string | undefined) {
  return status?.toLocaleLowerCase().replace(/_/g, " ") ?? "unknown";
}
