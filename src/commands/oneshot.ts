/**
 * `claudeclaw oneshot` (#552): read and edit one-shot routing in settings.json
 * without the dashboard. Same validation and the same messages as
 * `POST /api/settings/oneshot` (both call `updateOneShotSettings`); the
 * daemon picks the change up on its next settings reload, no restart.
 */
import { probeEngine } from "../oneshot/probe.js";
import {
  readOneShotSettings,
  readOneShotView,
  updateOneShotSettings,
} from "../oneshot/settings-store.js";

export interface OneshotIo {
  out: (line: string) => void;
  err: (line: string) => void;
}

const defaultIo: OneshotIo = {
  out: (line) => console.log(line),
  err: (line) => console.error(line),
};

export const ONESHOT_USAGE = [
  "Usage:",
  "  claudeclaw oneshot list                          Route → engine it uses now",
  "  claudeclaw oneshot set <route|default> <engine>  Route a call (or the default) to an engine",
  "  claudeclaw oneshot unset <route>                 Back to <family>.* or the default",
  "  claudeclaw oneshot engine add <name> --kind <openai-compatible|ollama> --base-url <url> --model <model> [--key-env <VAR>]",
  "  claudeclaw oneshot engine rm <name>",
  "  claudeclaw oneshot test <engine>                 Fixed prompt + injection canary",
  "",
  "The API key is never written to settings.json: export it and pass the NAME of the variable with --key-env.",
].join("\n");

const ENGINE_KINDS = ["openai-compatible", "ollama"];

function flags(args: string[]): { values: Record<string, string>; rest: string[] } {
  const values: Record<string, string> = {};
  const rest: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] ?? "";
    if (!arg.startsWith("--")) {
      rest.push(arg);
      continue;
    }
    const eq = arg.indexOf("=");
    if (eq > 0) values[arg.slice(2, eq)] = arg.slice(eq + 1);
    else {
      const value = args[i + 1];
      if (value === undefined || value.startsWith("--")) throw new Error(`${arg} needs a value`);
      values[arg.slice(2)] = value;
      i++;
    }
  }
  return { values, rest };
}

async function list(io: OneshotIo): Promise<number> {
  const view = await readOneShotView();
  io.out(`default  ${view.default}`);
  const width = Math.max(...view.knownRoutes.map((r) => r.length));
  for (const route of view.knownRoutes) {
    const family = `${route.split(".")[0]}.*`;
    const source = Object.hasOwn(view.routes, route)
      ? "route"
      : Object.hasOwn(view.routes, family)
        ? family
        : "default";
    io.out(`${route.padEnd(width)}  ${view.effective[route]}  (${source})`);
  }
  for (const engine of view.engines) {
    const where = engine.baseUrl ?? engine.tier ?? "";
    const key = engine.apiKeyEnv
      ? `key ${engine.apiKeyEnv}: ${engine.keyPresent ? "present" : "missing"}`
      : "no key";
    io.out(`engine ${engine.name}  ${engine.type}  ${where}  ${engine.model ?? ""}  ${key}`);
  }
  return 0;
}

async function engineCommand(args: string[], io: OneshotIo): Promise<number> {
  const [verb, ...tail] = args;
  if (verb === "rm") {
    const name = tail[0];
    if (!name || tail.length > 1) throw new Error("usage: claudeclaw oneshot engine rm <name>");
    await updateOneShotSettings({ engines: { [name]: null } });
    io.out(`engine ${name} removed`);
    return 0;
  }
  if (verb !== "add") throw new Error(`unknown engine command '${verb ?? ""}' (add, rm)`);
  const { values, rest } = flags(tail);
  if ("key" in values || "api-key" in values || "apiKey" in values)
    throw new Error(
      "the API key is never stored in settings.json: export it and pass the variable NAME with --key-env",
    );
  const name = rest[0];
  if (!name || rest.length > 1)
    throw new Error("usage: claudeclaw oneshot engine add <name> --kind ...");
  const kind = values.kind;
  if (!kind || !ENGINE_KINDS.includes(kind))
    throw new Error(`--kind must be one of: ${ENGINE_KINDS.join(", ")}`);
  for (const key of Object.keys(values))
    if (!["kind", "base-url", "model", "key-env"].includes(key))
      throw new Error(`unknown option --${key}`);
  const config: Record<string, unknown> = { type: kind };
  if (values["base-url"] !== undefined) config.baseUrl = values["base-url"];
  if (values.model !== undefined) config.model = values.model;
  if (values["key-env"] !== undefined) config.apiKeyEnv = values["key-env"];
  await updateOneShotSettings({ engines: { [name]: config } });
  io.out(`engine ${name} saved (${kind})`);
  if (config.apiKeyEnv && !process.env[config.apiKeyEnv as string])
    io.err(
      `warning: ${config.apiKeyEnv} is not set in this shell; the daemon needs it in its environment`,
    );
  return 0;
}

async function test(args: string[], io: OneshotIo): Promise<number> {
  const id = args[0];
  if (!id || args.length > 1) throw new Error("usage: claudeclaw oneshot test <engine>");
  try {
    // print / llm-router read daemon settings (model, router tiers) when present.
    const { loadSettings } = await import("../config.js");
    await loadSettings();
  } catch {
    /* the probe still runs on the oneShot block alone */
  }
  const result = await probeEngine(id, await readOneShotSettings());
  io.out(
    `engine ${result.engine}: isolation ${result.isolation}, ${result.latencyMs} ms, exit ${result.exitCode}`,
  );
  io.out(result.output);
  return result.isolation === "ok" && result.exitCode === 0 ? 0 : 1;
}

export async function runOneshotCommand(
  args: string[],
  io: OneshotIo = defaultIo,
): Promise<number> {
  const [command, ...rest] = args;
  try {
    switch (command) {
      case "list":
        return await list(io);
      case "set": {
        const [target, engine, ...extra] = rest;
        if (!target || !engine || extra.length > 0)
          throw new Error("usage: claudeclaw oneshot set <route|default> <engine>");
        await updateOneShotSettings(
          target === "default" ? { default: engine } : { routes: { [target]: engine } },
        );
        io.out(`${target} → ${engine}`);
        return 0;
      }
      case "unset": {
        const [route, ...extra] = rest;
        if (!route || extra.length > 0) throw new Error("usage: claudeclaw oneshot unset <route>");
        await updateOneShotSettings({ routes: { [route]: null } });
        io.out(`${route} → (default)`);
        return 0;
      }
      case "engine":
        return await engineCommand(rest, io);
      case "test":
        return await test(rest, io);
      case undefined:
      case "help":
      case "--help":
      case "-h":
        io.out(ONESHOT_USAGE);
        return command === undefined ? 1 : 0;
      default:
        throw new Error(`unknown oneshot command '${command}'\n${ONESHOT_USAGE}`);
    }
  } catch (err) {
    io.err(`error: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
}
