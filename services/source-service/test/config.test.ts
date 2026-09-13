import assert from "node:assert/strict";
import test from "node:test";
import { loadConfig, loadRuntimeConfig } from "../src/config.js";

const runtimeEnv = {
  SOURCE_DATABASE_URL: "postgresql://source.invalid/source",
  SOURCE_WORKER_POLL_MS: "250",
};

test("worker runtime config does not require API authentication secrets", () => {
  const config = loadRuntimeConfig(runtimeEnv);
  assert.equal(config.databaseURL, runtimeEnv.SOURCE_DATABASE_URL);
  assert.equal(config.workerPollMs, 250);
  assert.equal("bootstrapToken" in config, false);
  assert.equal("tokenSecret" in config, false);
  assert.equal("cursorSecret" in config, false);
});

test("OrbStack egress mode is explicit and restricted to a loopback development host", () => {
  const config = loadRuntimeConfig({
    ...runtimeEnv,
    SOURCE_HOST: "127.0.0.1",
    SOURCE_LOCAL_DEV_EGRESS_MODE: "orbstack-loopback",
  });
  assert.equal(config.localDevEgressMode, "orbstack-loopback");
  assert.equal(loadRuntimeConfig(runtimeEnv).localDevEgressMode, undefined);
  assert.throws(
    () =>
      loadRuntimeConfig({
        ...runtimeEnv,
        SOURCE_LOCAL_DEV_EGRESS_MODE: "allow-benchmark-range",
      }),
    /localDevEgressMode/,
  );
  assert.throws(
    () =>
      loadRuntimeConfig({
        ...runtimeEnv,
        SOURCE_HOST: "0.0.0.0",
        SOURCE_LOCAL_DEV_EGRESS_MODE: "orbstack-loopback",
      }),
    /localDevEgressMode/,
  );
});

test("API config requires secrets and can disable bootstrap pairing", () => {
  assert.throws(() => loadConfig(runtimeEnv), /bootstrapToken/);
  const config = loadConfig({
    ...runtimeEnv,
    SOURCE_BOOTSTRAP_TOKEN: "bootstrap-secret",
    SOURCE_TOKEN_SECRET: "t".repeat(32),
    SOURCE_CURSOR_SECRET: "c".repeat(32),
    SOURCE_PAIRING_ENABLED: "false",
  });
  assert.equal(config.pairingEnabled, false);
  assert.equal(config.recommendedDefaultsEnabled, true);
  assert.equal(
    config.recommendedSources?.[0]?.id,
    "openai-agents-js-changelog",
  );
  const custom = loadConfig({
    ...runtimeEnv,
    SOURCE_BOOTSTRAP_TOKEN: "bootstrap-secret",
    SOURCE_TOKEN_SECRET: "t".repeat(32),
    SOURCE_CURSOR_SECRET: "c".repeat(32),
    SOURCE_RECOMMENDED_DEFAULTS_ENABLED: "false",
    SOURCE_RECOMMENDED_SOURCES_JSON: JSON.stringify([
      {
        id: "custom-release-notes",
        name: "HTTP Semantics",
        category: "标准",
        description: "RFC Editor 发布的 HTTP Semantics 标准正文。",
        url: "https://www.rfc-editor.org/rfc/rfc9110.txt",
        refreshIntervalMinutes: 120,
        enabledByDefault: true,
      },
    ]),
  });
  assert.equal(custom.recommendedDefaultsEnabled, false);
  assert.equal(custom.recommendedSources?.[0]?.id, "custom-release-notes");
  assert.throws(
    () =>
      loadConfig({
        ...runtimeEnv,
        SOURCE_BOOTSTRAP_TOKEN: "bootstrap-secret",
        SOURCE_TOKEN_SECRET: "t".repeat(32),
        SOURCE_CURSOR_SECRET: "c".repeat(32),
        SOURCE_PAIRING_ENABLED: "sometimes",
      }),
    /pairingEnabled/,
  );
  assert.throws(
    () =>
      loadConfig({
        ...runtimeEnv,
        SOURCE_BOOTSTRAP_TOKEN: "bootstrap-secret",
        SOURCE_TOKEN_SECRET: "t".repeat(32),
        SOURCE_CURSOR_SECRET: "c".repeat(32),
        SOURCE_RECOMMENDED_SOURCES_JSON: "not-json",
      }),
    /recommendedSources/,
  );
});
