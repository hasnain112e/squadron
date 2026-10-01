import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { collectAllowlistedProviderAuthEnv, createDaemon } from "../src/startup.js";
import { GeminiRuntimeAdapter } from "../src/adapters/gemini-runtime-adapter.js";
import type { CmuxTransportFactory } from "../src/adapters/cmux.js";
import type { ExecFn } from "../src/adapters/tmux.js";

// The adapter's own tests build it by hand. Only booting the daemon the way `squad start` does shows that
// startup.ts hands it to the two places that launch seats, and lets sign-in variables reach a seat.
describe("createDaemon wires the Gemini runtime", { timeout: 60_000 }, () => {
  beforeAll(() => {
    process.env.OPENRIG_NO_KERNEL = "1";
  });
  afterAll(() => {
    delete process.env.OPENRIG_NO_KERNEL;
  });

  it("registers a gemini adapter for the pod instantiator and for the routes", async () => {
    const cmuxFactory: CmuxTransportFactory = async () => {
      throw Object.assign(new Error("no socket"), { code: "ENOENT" });
    };
    const tmuxExec: ExecFn = async () => "";
    const { db, deps } = await createDaemon({ cmuxFactory, tmuxExec });
    try {
      expect(deps.runtimeAdapters?.["gemini"]).toBeInstanceOf(GeminiRuntimeAdapter);
      const instantiator = deps.podInstantiator as unknown as { deps: { adapters: Record<string, unknown> } };
      expect(instantiator.deps.adapters["gemini"]).toBeInstanceOf(GeminiRuntimeAdapter);
      // The runtimes that were already there are still there.
      expect(Object.keys(instantiator.deps.adapters)).toEqual(expect.arrayContaining(["claude-code", "codex", "gemini", "pi", "terminal"]));
    } finally {
      db.close();
    }
  });
});

describe("Gemini sign-in variables", () => {
  const env = { GEMINI_API_KEY: "key-1", GOOGLE_API_KEY: "key-2", GOOGLE_CLOUD_PROJECT: "proj", GOOGLE_GENAI_USE_VERTEXAI: "true" };

  it("reach a seat only when the operator names them", () => {
    expect(collectAllowlistedProviderAuthEnv("GEMINI_API_KEY, GOOGLE_CLOUD_PROJECT", env)).toEqual({ GEMINI_API_KEY: "key-1", GOOGLE_CLOUD_PROJECT: "proj" });
    expect(collectAllowlistedProviderAuthEnv(undefined, env)).toEqual({});
    expect(collectAllowlistedProviderAuthEnv("", env)).toEqual({});
  });

  it("can be named for Vertex AI too, and an unrelated variable is still refused", () => {
    expect(collectAllowlistedProviderAuthEnv("GOOGLE_GENAI_USE_VERTEXAI,GOOGLE_API_KEY,HOME", { ...env, HOME: "/home/me" })).toEqual({
      GOOGLE_GENAI_USE_VERTEXAI: "true",
      GOOGLE_API_KEY: "key-2",
    });
  });
});
