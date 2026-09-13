import { spawn } from "node:child_process";
import { createServer } from "node:net";

const project = `ytriple-source-test-${process.pid}`;
const compose = [
  "compose",
  "--project-name",
  project,
  "-f",
  "services/source-service/compose.test.yml",
];

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: "inherit",
      ...options,
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} 退出：${code ?? signal}`));
    });
  });
}

const port = await new Promise((resolve, reject) => {
  const server = createServer();
  server.once("error", reject);
  server.listen(0, "127.0.0.1", () => {
    const address = server.address();
    const selected = typeof address === "object" && address ? address.port : 0;
    server.close((error) => (error ? reject(error) : resolve(selected)));
  });
});

const env = {
  ...process.env,
  SOURCE_TEST_POSTGRES_PORT: String(port),
  SOURCE_TEST_DATABASE_URL: `postgresql://ytriple_source_test:ytriple_source_test@127.0.0.1:${port}/ytriple_source_test`,
};

let started = false;
try {
  await run(
    "npm",
    ["run", "build", "--workspace", "@ytriple/source-contract"],
    {
      env,
    },
  );
  started = true;
  await run("docker", [...compose, "up", "--detach", "--wait"], { env });
  await run(
    "npx",
    [
      "tsx",
      "--test",
      "--test-concurrency=1",
      "services/source-service/test/integration/api.test.ts",
      "tests/integration/source-push.test.ts",
    ],
    { env },
  );
} finally {
  if (started)
    await run("docker", [...compose, "down", "--volumes", "--remove-orphans"], {
      env,
    }).catch(() => {});
}
