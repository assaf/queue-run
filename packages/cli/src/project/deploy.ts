import { IAM } from "@aws-sdk/client-iam";
import chalk from "chalk";
import { Command } from "commander";
import ms from "ms";
import ora from "ora";
import {
  deployLambda,
  setupAPIGateway,
  setupIntegrations,
} from "queue-run-builder";
import invariant from "tiny-invariant";
import { loadCredentials } from "./project.js";

const command = new Command("deploy")
  .description("deploy your project")
  .argument("[name]", "the project name")
  .option("--region <region>", "AWS region", "us-east-1")
  .addHelpText(
    "after",
    `
Automated deployment:
- Use command line options to specify the project name, region, etc
- CI server should supply the environment variables AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY

Deploying from your devbox:
- Run npx queue-run deploy without any options
- It will ask you for project name, AWS credentials, etc
- These are stored in .queue-run.json, also used for view logs, managing env variables, etc
`
  )
  .action(async (name, { region: awsRegion }: { region: string }) => {
    const project = await loadCredentials({ name, awsRegion });
    const accountId = await getAccountId(project.awsRegion);

    const spinner = ora("Setting up API Gateway...").start();
    const { httpUrl, wsUrl, wsApiId } = await setupAPIGateway({
      project: project.name,
      region: project.awsRegion,
    });
    spinner.succeed("Created API Gateway endpoints");

    const lambdaArn = await deployLambda({
      buildDir: ".queue-run",
      sourceDir: process.cwd(),
      config: {
        accountId,
        env: "production",
        httpUrl,
        region: project.awsRegion,
        slug: project.name,
        wsApiId,
        wsUrl,
      },
    });
    await setupIntegrations({
      project: project.name,
      lambdaArn,
      region: project.awsRegion,
    });

    console.info(chalk.bold.green(`Your API is available at:\t%s`), httpUrl);
    console.info(chalk.bold.green(`WebSocket available at:\t\t%s`), wsUrl);
    console.info(`Try:\n  curl ${httpUrl}`);

    console.info(
      chalk.bold.green("🐇 Done in %s"),
      ms(process.uptime() * 1000)
    );
  });

export default command;

async function getAccountId(region: string): Promise<string> {
  const iam = new IAM({ region });
  const { User: user } = await iam.getUser({});
  const accountId = user?.Arn?.split(":")[4];
  invariant(accountId, "Could not determine account ID");
  return accountId;
}
