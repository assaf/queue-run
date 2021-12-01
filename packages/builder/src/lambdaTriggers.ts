import { lambda } from "./clients";

export async function addTriggers(lambdaName: string, sourceArns: string[]) {
  if (sourceArns.length === 0) return;
  const { EventSourceMappings } = await lambda.listEventSourceMappings({
    FunctionName: lambdaName,
  });
  const arnToUUID = new Map<string, string>(
    EventSourceMappings?.map(
      ({ EventSourceArn, UUID }) => [EventSourceArn, UUID] as [string, string]
    )
  );

  console.info("λ: adding triggers …");
  await Promise.all(
    sourceArns.map(async (arn) => {
      const uuid = arnToUUID.get(arn);
      if (uuid) {
        await lambda.updateEventSourceMapping({
          UUID: uuid,
          FunctionName: lambdaName,
        });
      } else {
        const { UUID } = await lambda.createEventSourceMapping({
          Enabled: true,
          FunctionName: lambdaName,
          EventSourceArn: arn,
        });
        if (!UUID) throw new Error(`Could not create event source for ${arn}`);
      }
    })
  );
}

export async function removeTriggers(lambdaName: string, sourceArns: string[]) {
  const { EventSourceMappings } = await lambda.listEventSourceMappings({
    FunctionName: lambdaName,
  });
  if (!EventSourceMappings) return;

  const set = new Set(sourceArns);
  const removing = EventSourceMappings.filter(
    ({ EventSourceArn }) => EventSourceArn && !set.has(EventSourceArn)
  );
  if (removing.length === 0) return;

  console.info("λ: removing triggers", lambdaName);
  await Promise.all(
    removing.map(({ UUID }) => lambda.deleteEventSourceMapping({ UUID }))
  );
}