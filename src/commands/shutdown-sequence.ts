/**
 * The daemon's shutdown order, pulled out of `start.ts` so it can be tested (#549).
 *
 *   drain in-flight turns -> save memory -> tear down plugins/adapters/web
 *   -> stop the bus -> finalize (PID file, statusline)
 *
 * The memory save sits after the drain, so no turn is still writing, and before the
 * bus goes away. A failing drain or save is reported and the teardown goes on: a
 * shutdown that stops half-way leaves a daemon that is neither up nor gone.
 */

export interface ShutdownController {
  /** First call: `"start"`. Every later call (a second SIGTERM/SIGINT): `"abort"`. */
  request(): "start" | "abort";
  /** True once a second signal arrived. */
  readonly aborted: boolean;
  /** Fires on that second signal; hand it to anything that waits (drain, save). */
  readonly signal: AbortSignal;
}

export function createShutdownController(): ShutdownController {
  const controller = new AbortController();
  let requested = false;
  return {
    request() {
      if (!requested) {
        requested = true;
        return "start";
      }
      controller.abort();
      return "abort";
    },
    get aborted() {
      return controller.signal.aborted;
    },
    signal: controller.signal,
  };
}

export interface ShutdownSteps {
  drain: () => Promise<unknown>;
  saveMemory: () => Promise<unknown>;
  /** Plugins, adapters, web, trackers: everything that goes before the bus. */
  teardown: () => Promise<unknown>;
  stopBus: () => Promise<unknown>;
  finalize: () => Promise<unknown>;
  onStepError?: (step: "drain" | "saveMemory", err: unknown) => void;
}

export async function runShutdownSequence(steps: ShutdownSteps): Promise<void> {
  try {
    await steps.drain();
  } catch (err) {
    steps.onStepError?.("drain", err);
  }
  try {
    await steps.saveMemory();
  } catch (err) {
    steps.onStepError?.("saveMemory", err);
  }
  await steps.teardown();
  await steps.stopBus();
  await steps.finalize();
}
