import path from "path";
import { compile } from "path-to-regexp";
import { URL } from "url";
import { getLocalStorage, selfPath } from "../shared/index.js";

type Params = {
  [key: string]: string | number | boolean | (string | number | boolean)[];
};

/* eslint-disable no-unused-vars */
interface URLFunction<P = Params, Q = Params> {
  /**
   * Returns URL for the given path by expanding path parameters and adding
   * query string parameters.
   *
   * ```
   * url('/bookmarks/:id', { id: '123' })
   * => https://example.com/bookmarks/123
   *
   * url('/bookmarks', null, { sort: 'date' })
   * => https://example.com/bookmarks?sort=date
   * ```
   *
   * You can call this with a path or URL object. Relative paths are expanded to
   * absolute paths. file: paths also work so long as they point inside the
   * project.
   */
  (path: string | URL, params?: P, query?: Q): string;

  /**
   * Returns URL constructor function for the given path.
   *
   * `url.for(path)(params, query)` is equivalent to `url(path, params, query)`.
   */
  for<P = Params, Q = Params>(path: string | URL): URLConstructor<P, Q>;

  /**
   * Returns URL constructor function for this module.
   *
   * Shortcut for `url.for(import.meta.url)`.
   */
  self<P = Params, Q = Params>(): URLConstructor<P, Q>;
}

interface URLConstructor<P = Params, Q = Params> {
  /**
   * Returns URL by expanding path parameters and adding
   *
   * ```
   * myURL({ id: '123' })
   * => https://example.com/bookmarks/123
   * ```
   */
  (params?: P, query?: Q): string;
}
/* eslint-enable no-unused-vars */

const url: URLFunction<{}, {}> = (
  pathOrURL: string | URL,
  params?: { [key: string]: unknown | unknown[] },
  query?: { [key: string]: unknown | unknown[] }
): string => {
  const urls = getLocalStorage().urls;
  if (!urls) throw new Error("No runtime available");

  const baseURL = pathOrURL instanceof URL ? pathOrURL.origin : urls.http;
  const pathname = getPath(pathOrURL, baseURL);
  const expanded = compile(replaceBracket(pathname))(params);
  const url = new URL(expanded, baseURL);
  if (query) {
    Object.entries(query).forEach(([key, value]) => {
      if (Array.isArray(value))
        value.forEach((value) => url.searchParams.append(key, value));
      else if (value !== undefined) url.searchParams.append(key, String(value));
    });
  }

  return url.href;
};

url.for = <P, Q>(path: string | URL) => {
  const constructor: URLConstructor<P, Q> = (params, query) =>
    url(path, params, query);

  constructor.toString = () => url(path);
  constructor.valueOf = () => url(path);
  return constructor;
};
url.self = <P, Q>() => {
  const pathname = selfPath();
  if (!pathname.startsWith("api/"))
    throw new Error("You can only use self from an api route");
  return url.for<P, Q>(pathname.slice(4));
};

export default url;

function getPath(pathOrURL: string | URL, baseURL: string): string {
  const { pathname, protocol } = new URL(String(pathOrURL), baseURL);
  return protocol === "file:"
    ? path.relative(process.cwd(), pathname).replace(/\.js$/, "")
    : pathname;
}

function replaceBracket(path: string): string {
  return path.replace(
    /(^|\/)\[(.+?)\](\/|\?|#|$)/g,
    (_, before, name, after) =>
      `${before}:${name.startsWith("...") ? name.slice(3) + "*" : name}${after}`
  );
}
