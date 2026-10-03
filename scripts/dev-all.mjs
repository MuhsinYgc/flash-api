import { spawn } from "node:child_process";

const child = spawn("node", ["show-server/server.mjs"], {
  stdio: "inherit",
  shell: true,
});

function shutdown() {
  child.kill();
  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

child.on("exit", (code) => {
  process.exit(code ?? 0);
});
