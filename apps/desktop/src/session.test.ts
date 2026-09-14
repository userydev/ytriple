import {
  createFakeClock,
  createFakeFsPort,
  createFakeOutputPort,
  createSilentUserPort,
} from "@ytriple/core";
import type { HttpPort, SecretPort, YtripleConfig } from "@ytriple/shared";
import { describe, expect, it } from "vitest";
import { createDesktopSession, desktopCapabilities, type DesktopBridge } from "./session.js";

const config: YtripleConfig = {
  providers: [
    {
      providerId: "ark",
      adapterId: "ark",
      displayName: "Ark",
      credentialRef: "ARK_API_KEY",
      models: [{ modelId: "doubao-seed-1-6", displayName: "Doubao" }],
    },
  ],
  defaultModel: { providerId: "ark", modelId: "doubao-seed-1-6" },
};

const http: HttpPort = {
  async request() {
    throw new Error("the desktop placeholder never calls out during a unit test");
  },
};

const secrets: SecretPort = {
  async resolve() {
    return "not-used";
  },
};

function bridge(overrides: Partial<DesktopBridge> = {}): DesktopBridge {
  return {
    config,
    http,
    secrets,
    output: createFakeOutputPort(),
    clock: createFakeClock(),
    user: createSilentUserPort(),
    ...overrides,
  };
}

describe("desktop host boundary", () => {
  it("offers workspace reading only when the user granted a folder", () => {
    expect(desktopCapabilities(bridge()).workspaceRead).toBe(false);
    expect(
      desktopCapabilities(bridge({ fs: createFakeFsPort({ files: {} }) })).workspaceRead,
    ).toBe(true);
  });

  it("claims the capabilities only a desktop host has", () => {
    const capabilities = desktopCapabilities(bridge());
    expect(capabilities.localModels).toBe(true);
    expect(capabilities.outputWrite).toBe(true);
  });

  it("builds a runtime from core rather than implementing one", () => {
    const session = createDesktopSession("task-1", bridge());
    expect(typeof session.runtime.run).toBe("function");
    expect(typeof session.runtime.subscribe).toBe("function");
    expect(session.runtime.events()).toEqual([]);
    expect(session.team.teamId).toBe("prd.default");
  });

  it("lets a host narrow what it claims it can do", () => {
    const capabilities = desktopCapabilities(
      bridge({ capabilityOverrides: { localModels: false, streaming: false } }),
    );
    expect(capabilities.localModels).toBe(false);
    expect(capabilities.streaming).toBe(false);
    expect(capabilities.outputWrite).toBe(true);
  });

  it("accepts a host that routes models itself, such as a replay host", async () => {
    let asked = 0;
    const session = createDesktopSession(
      "task-1",
      bridge({
        resolveBinding: async () => {
          asked += 1;
          throw new Error("stop here; the binding resolver was used");
        },
      }),
    );

    const outcome = await session.runtime.run({ userInput: "an idea" });
    expect(asked).toBeGreaterThan(0);
    expect(outcome.status).toBe("failed");
  });
});
