import { Sandbox } from "../dist/index.js";

const secretValue = "dummy_gh_token_value";

const sandbox = await Sandbox.create({
  image: "agent-sandbox-gh",
  allowNet: ["api.github.com"],
  debugInjectHeader: true,
  secrets: {
    GH_TOKEN: {
      hosts: ["api.github.com"],
      value: secretValue,
    },
  },
});

try {
  const envResult = await sandbox.exec("echo $GH_TOKEN");
  if (envResult.stdout.trim() === secretValue) {
    throw new Error("GH_TOKEN leaked into sandbox env");
  }
  console.log("Sandbox env GH_TOKEN:", envResult.stdout.trim());

  const apiResult = await sandbox.exec("gh api -i user");
  const output = `${apiResult.stdout}\n${apiResult.stderr}`.toLowerCase();
  if (!output.includes("x-agent-sandbox-injected: gh_token")) {
    throw new Error("GH injection header not found in gh output");
  }

  const proxyLogs = await sandbox.proxyLogs(20);
  console.log("Proxy logs (last 20 lines):\n" + proxyLogs);

  console.log("GH CLI injection validated.");
} finally {
  await sandbox.close();
}
