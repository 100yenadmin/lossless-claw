import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import lcmPlugin from "../index.js";
import { closeLcmConnection } from "../src/db/connection.js";
import { resetStartupBannerLogsForTests } from "../src/startup-banner-log.js";

type HookHandler = (event: unknown, context: unknown) => unknown;

function buildApi(pluginConfig: Record<string, unknown>): {
  api: OpenClawPluginApi;
  getHook: (hookName: string) => HookHandler | undefined;
} {
  const hooks = new Map<string, HookHandler[]>();

  const api = {
    id: "lossless-claw",
    name: "Lossless Context Management",
    source: "/tmp/lossless-claw",
    config: {},
    pluginConfig,
    runtime: {
      subagent: {
        run: vi.fn(),
        waitForRun: vi.fn(),
        getSession: vi.fn(),
        deleteSession: vi.fn(),
      },
      modelAuth: {
        getApiKeyForModel: vi.fn(async () => undefined),
        resolveApiKeyForProvider: vi.fn(async () => undefined),
      },
      config: {
        loadConfig: vi.fn(() => ({})),
      },
      channel: {
        session: {
          resolveStorePath: vi.fn(() => "/tmp/nonexistent-session-store.json"),
        },
      },
    },
    logger: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    },
    registerContextEngine: vi.fn(),
    registerTool: vi.fn(),
    registerHook: vi.fn(),
    registerHttpHandler: vi.fn(),
    registerHttpRoute: vi.fn(),
    registerChannel: vi.fn(),
    registerGatewayMethod: vi.fn(),
    registerCli: vi.fn(),
    registerService: vi.fn(),
    registerProvider: vi.fn(),
    registerCommand: vi.fn(),
    resolvePath: vi.fn(() => "/tmp/fake-agent"),
    on: vi.fn((hookName: string, handler: HookHandler) => {
      const existing = hooks.get(hookName) ?? [];
      existing.push(handler);
      hooks.set(hookName, existing);
    }),
  } as unknown as OpenClawPluginApi;

  return {
    api,
    getHook: (hookName: string) => hooks.get(hookName)?.[0],
  };
}

describe("lcm plugin prompt hook", () => {
  const dbPaths = new Set<string>();

  afterEach(() => {
    for (const dbPath of dbPaths) {
      closeLcmConnection(dbPath);
    }
    dbPaths.clear();
    resetStartupBannerLogsForTests();
  });

  it("registers before_prompt_build static recall policy through prepend context", async () => {
    const dbPath = join(tmpdir(), `lossless-claw-${Date.now()}-${Math.random().toString(16)}.db`);
    dbPaths.add(dbPath);

    const { api, getHook } = buildApi({
      enabled: true,
      dbPath,
    });

    lcmPlugin.register(api);

    expect(api.on).toHaveBeenCalledWith("before_prompt_build", expect.any(Function));

    const handler = getHook("before_prompt_build");
    expect(handler).toBeTypeOf("function");

    const result = (await handler?.(
      {
        prompt: "What changed earlier in this conversation?",
        messages: [],
      },
      {},
    )) as {
      prependContext?: string;
      prependSystemContext?: string;
      systemPrompt?: string;
    };

    expect(result).toMatchObject({
      prependContext: expect.any(String),
      prependSystemContext: expect.any(String),
    });
    expect(result.prependContext).toBe(result.prependSystemContext);
    expect(result.systemPrompt).toBeUndefined();
    expect(result.prependSystemContext).toContain("The lossless-claw plugin is active");
    expect(result.prependSystemContext).toContain(
      "these instructions supersede generic memory-recall guidance",
    );
    expect(result.prependSystemContext).toContain("Recall order for compacted conversation history:");
    expect(result.prependSystemContext).toContain("1. `lcm_grep`");
    expect(result.prependSystemContext).toContain("2. `lcm_describe`");
    expect(result.prependSystemContext).toContain("3. `lcm_expand_query`");
    expect(result.prependSystemContext).toContain(
      "Use `memory_search` / `memory_get` only if lossless-claw does not return enough evidence",
    );
    expect(result.prependSystemContext).toContain(
      "Lossless-claw does not supersede memory tools globally",
    );
  });
});
