import { Sandbox } from "../dist/index.js";

const token = process.env.GH_TOKEN;
if (!token) {
  console.error("GH_TOKEN is not set.");
  process.exit(1);
}

const sandbox = await Sandbox.create({
  image: "agent-sandbox-gh",
  allowNet: ["api.github.com"],
  secrets: {
    GH_TOKEN: {
      hosts: ["api.github.com"],
      value: token,
    },
  },
});

try {
  const envResult = await sandbox.exec("echo $GH_TOKEN");
  if (envResult.stdout.trim() === token) {
    throw new Error("GH_TOKEN leaked into sandbox env");
  }
  console.log("Sandbox env GH_TOKEN:", envResult.stdout.trim());

  const apiResult = await sandbox.exec("gh api user");
  if (apiResult.exitCode !== 0) {
    throw new Error(`GH CLI auth failed (exit ${apiResult.exitCode})`);
  }
  console.log("gh api user:\n" + apiResult.stdout.trim());

  const repoList = await sandbox.exec("gh repo list --limit 5");
  if (repoList.exitCode !== 0) {
    throw new Error(`gh repo list failed (exit ${repoList.exitCode})`);
  }
  console.log("gh repo list --limit 5:\n" + repoList.stdout.trim());

  const testRepo = process.env.GH_TEST_REPO;
  if (testRepo) {
    const prList = await sandbox.exec(`gh pr list --repo ${testRepo} --limit 5`);
    if (prList.exitCode !== 0) {
      throw new Error(`gh pr list failed (exit ${prList.exitCode})`);
    }
    console.log(`gh pr list --repo ${testRepo} --limit 5:\n` + prList.stdout.trim());
  } else {
    console.log("GH_TEST_REPO not set; skipping gh pr list.");
  }

  const proxyLogs = await sandbox.proxyLogs(20);
  console.log("Proxy logs (last 20 lines):\n" + proxyLogs);

  console.log("GH CLI real-token validation succeeded.");
} finally {
  await sandbox.close();
}
