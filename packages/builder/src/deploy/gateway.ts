import {
  Api,
  ApiGatewayV2,
  CreateApiRequest,
  ProtocolType,
} from "@aws-sdk/client-apigatewayv2";
import invariant from "tiny-invariant";
import { wsStage } from "../constants.js";
import { listDomainNames } from "../manage/domains.js";

// See https://docs.aws.amazon.com/lambda/latest/dg/services-apigateway.html#apigateway-permissions

/**
 * Returns HTTP and WS URLs from API Gateway: custom domain name if available.
 *
 * @param project Project name
 * @returns HTTP and WS URLs
 * @throws If API Gateway not configured yet
 */
export async function getAPIGatewayUrls({
  project,
  region,
}: {
  project: string;
  region: string;
}): Promise<{
  httpApiId: string;
  httpUrl: string;
  wsApiId: string;
  wsUrl: string;
}> {
  const apiGateway = new ApiGatewayV2({ region });
  const [http, ws] = await Promise.all([
    findGatewayAPI({ apiGateway, protocol: ProtocolType.HTTP, project }),
    findGatewayAPI({ apiGateway, protocol: ProtocolType.WEBSOCKET, project }),
  ]);
  if (!(http?.ApiEndpoint && ws?.ApiEndpoint))
    throw new Error("Project has not been deployed successfully");

  const domainNames = await listDomainNames(apiGateway, http.ApiId!);
  for (const domainName of domainNames) {
    const { Items } = await apiGateway.getApiMappings({
      DomainName: domainName,
    });
    if (Items?.find(({ ApiId }) => ApiId === http.ApiId)) {
      const domain = domainName!.replace("*.", "");
      return {
        httpApiId: http.ApiId!,
        httpUrl: `https://${domain}`,
        wsApiId: ws.ApiId!,
        wsUrl: `wss://ws.${domain}`,
      };
    }
  }

  return {
    httpApiId: http.ApiId!,
    httpUrl: http.ApiEndpoint,
    wsApiId: ws.ApiId!,
    wsUrl: `${ws.ApiEndpoint}/${wsStage}`,
  };
}

// Setup API Gateway. We need the endpoint URLs before we can deploy the project
// for the first time.
export async function setupAPIGateway({
  project,
  region,
}: {
  project: string;
  region: string;
}): Promise<{
  httpApiId: string;
  httpUrl: string;
  websocketUrl: string;
  websocketApiId: string;
}> {
  const apiGateway = new ApiGatewayV2({ region });
  const [http, websocket] = await Promise.all([
    createApi(apiGateway, project, ProtocolType.HTTP),
    createApi(apiGateway, project, ProtocolType.WEBSOCKET, {
      RouteSelectionExpression: "*",
    }),
  ]);
  invariant(http.ApiId);
  invariant(websocket.ApiId);

  const { httpUrl, wsUrl } = await getAPIGatewayUrls({ project, region });
  return {
    httpApiId: http.ApiId,
    httpUrl,
    websocketUrl: wsUrl,
    websocketApiId: websocket.ApiId,
  };
}

async function createApi(
  apiGateway: ApiGatewayV2,
  project: string,
  protocol: ProtocolType,
  options?: Omit<CreateApiRequest, "Name" | "ProtocolType">
) {
  const existing = await findGatewayAPI({ apiGateway, project, protocol });
  const args = {
    ProtocolType: protocol,
    Description: `QueueRun API gateway for project ${project} (${protocol})`,
    Name: `qr-${protocol.toLowerCase()}-${project}`,
    ApiId: existing?.ApiId,
    ...options,
  };

  const api = await (existing
    ? apiGateway.updateApi(args)
    : apiGateway.createApi(args));
  invariant(api.ApiEndpoint);
  return api;
}

export async function findGatewayAPI({
  apiGateway,
  nextToken,
  project,
  protocol,
}: {
  apiGateway: ApiGatewayV2;
  nextToken?: string;
  project: string;
  protocol: ProtocolType;
}): Promise<Api | null> {
  const result = await apiGateway.getApis({
    ...(nextToken && { NextToken: nextToken }),
  });
  const name = `qr-${protocol.toLowerCase()}-${project}`;
  const api = result.Items?.find((api) => api.Name === name);
  if (api) return api;
  return result.NextToken
    ? await findGatewayAPI({
        apiGateway,
        nextToken: result.NextToken,
        project,
        protocol,
      })
    : null;
}

export async function deleteAPIGateway({
  project,
  region,
}: {
  project: string;
  region: string;
}) {
  const apiGateway = new ApiGatewayV2({ region });
  await Promise.all([
    deleteApi(apiGateway, project, ProtocolType.HTTP),
    deleteApi(apiGateway, project, ProtocolType.WEBSOCKET),
  ]);
}

async function deleteApi(
  apiGateway: ApiGatewayV2,
  project: string,
  protocol: ProtocolType
) {
  const api = await findGatewayAPI({ apiGateway, protocol, project });
  if (api?.ApiId) await apiGateway.deleteApi({ ApiId: api.ApiId });
}
