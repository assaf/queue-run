import path from "path";

export default function selfPath(depth: number = 2): string {
  const prepare = Error.prepareStackTrace;
  let filename: string | null = null;
  Error.prepareStackTrace = (_, callSites) => {
    filename =
      callSites[depth]?.getFileName()?.replace(/^file:\/\//, "") ?? null;
  };
  const error = new Error();
  Error.captureStackTrace(error);
  error.stack?.trim();
  Error.prepareStackTrace = prepare;
  if (typeof filename === "string")
    return path.relative(process.cwd(), filename).replace(/\.(js|ts)x?$/, "");
  else throw new Error("Could not determine filename");
}
