import { Sandbox } from "../dist/index.js";

const secretValue = "test_secret_value_123";

const sandbox = await Sandbox.create({
  image: "curlimages/curl:8.6.0",
  allowNet: ["httpbin.org"],
  debugInjectHeader: true,
  secrets: {
    TEST_TOKEN: {
      hosts: ["httpbin.org"],
      value: secretValue,
    },
  },
});

try {
  const envResult = await sandbox.exec("echo $TEST_TOKEN");
  if (envResult.stdout.trim() === secretValue) {
    throw new Error("Secret leaked into sandbox env");
  }
  console.log("Sandbox env TEST_TOKEN:", envResult.stdout.trim());

  const headerResult = await sandbox.exec(
    "curl -s -D - -o /dev/null -H \"Authorization: Bearer $TEST_TOKEN\" https://httpbin.org/anything",
  );

  if (!headerResult.stdout.toLowerCase().includes("x-agent-sandbox-injected: test_token")) {
    throw new Error("Secret injection header not found");
  }

  const proxyLogs = await sandbox.proxyLogs(20);
  console.log("Proxy logs (last 20 lines):\n" + proxyLogs);

  console.log("Secret injection validated.");
} finally {
  await sandbox.close();
}
