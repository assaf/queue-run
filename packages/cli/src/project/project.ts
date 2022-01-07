import glob from "fast-glob";
import fs from "fs/promises";
import inquirer from "inquirer";

const filename = ".queue-run.json";

type Project = {
  name?: string;
  runtime?: "lambda";
};

export async function loadProject(): Promise<Project> {
  let source;
  try {
    source = await fs.readFile(filename, "utf8");
  } catch {
    return {};
  }
  try {
    return JSON.parse(source);
  } catch (error) {
    throw new Error(`Syntax error in ${filename}: ${String(error)}`);
  }
}

export async function saveProject({ name, runtime }: Project) {
  const project = { name, runtime };
  await fs.writeFile(filename, JSON.stringify(project, null, 2));
}

export async function initProject() {
  const project = await loadProject();

  const suggestedName =
    project.name ??
    (await fs
      .readFile("package.json", "utf8")
      .then(JSON.parse)
      .then((pkg) => pkg.name)
      .catch(() => null));

  const isTypescript = (await glob("**/*.{ts,tsx}")).length > 0;

  const answers = await inquirer.prompt([
    {
      default: suggestedName,
      message: "Project name (alphanumeric + dashes)",
      name: "name",
      type: "input",
      validate: (input: string) =>
        /^[a-zA-Z0-9-]{1,40}$/.test(input)
          ? true
          : "Project name must be 1-40 characters long and can only contain letters, numbers, and dashes",
    },
    {
      default: isTypescript ? "typescript" : "javascript",
      message: "JavaScript or TypeScript?",
      name: "language",
      type: "list",
      choices: [
        { name: "JavaScript", value: "javascript" },
        { name: "TypeScript", value: "typescript" },
      ],
    },
    {
      default: "lambda",
      name: "runtime",
      message: "Which Runtime?",
      type: "list",
      choices: [
        { name: "AWS: Lambda + API Gateway + SQS + DynamoDB", value: "lambda" },
      ],
    },
  ]);
  const { name, runtime } = answers;
  await saveProject({ name, runtime });
  return answers;
}