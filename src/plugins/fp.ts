/** Minimal fastify-plugin shim so we avoid an extra dependency. */
import type { FastifyPluginAsync, FastifyPluginCallback } from "fastify";

type Plugin = FastifyPluginAsync | FastifyPluginCallback;

export default function fp<T extends Plugin>(plugin: T, opts?: { name?: string }): T {
  const wrapped = plugin as T & { default?: T; [key: symbol]: unknown };
  Object.defineProperty(wrapped, Symbol.for("skip-override"), { value: true });
  if (opts?.name) Object.defineProperty(wrapped, Symbol.for("fastify.display-name"), { value: opts.name });
  return wrapped;
}
