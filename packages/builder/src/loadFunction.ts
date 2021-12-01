import chokidar from "chokidar";
import path from "path";
import loadModule from "./loadModule";

type FunctionExports = {
  config: { [key: string]: unknown };
  handler: (...all: unknown[]) => Promise<void> | void;
};

// Load a single function.  In development mode, this also hot-reloads the function.
export default function loadFunction(
  filename: string,
  watch?: boolean
): FunctionExports {
  const paths = new Set<string>();
  const loaded = loadAndVerify({ filename, paths });

  if (watch) {
    const watcher = chokidar.watch(Array.from(paths), { ignoreInitial: true });
    watcher.on("change", (changed) => {
      console.debug(
        "File %s changed => reloading %s",
        path.relative(process.cwd(), changed),
        path.relative(process.cwd(), filename)
      );

      try {
        Object.assign(loaded, loadAndVerify({ filename, paths }));
      } catch (error) {
        console.error("Error loading %s", filename, (error as Error).stack);
      }
      watcher.add(Array.from(paths));
    });
  }

  return exports;
}

function loadAndVerify({
  filename,
  paths,
}: {
  filename: string;
  paths: Set<string>;
}): FunctionExports {
  const cache = {};
  try {
    const start = Date.now();
    const full = path.resolve(process.cwd(), filename);

    const { exports } = loadModule({ filename: full, cache });

    const handler = exports.handler || exports.default;
    if (typeof handler !== "function") {
      throw new Error(`Expected ${filename} to export a function (default)`);
    }

    const config = exports.config || {};
    if (typeof config !== "object") {
      throw new Error(`Expected ${filename} to export an object (config)`);
    }

    console.debug("Loaded %s in %sms", filename, Date.now() - start);
    return { config, handler };
  } finally {
    paths.clear();
    Object.keys(cache).forEach((path) => paths.add(path));
  }
}