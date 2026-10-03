import { spawn } from "node:child_process";

const children = [
  spawn("npx", ["next", "dev", "--webpack", "-p", "3201"], {
    stdio: "inherit",
    shell: true,
  }),
  spawn("node", ["show-server/server.mjs"], {
    stdio: "inherit",
    shell: true,
  }),
];

function shutdown() {
  for (const child of children) {
    child.kill();
  }
  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

for (const child of children) {
  child.on("exit", (code) => {
    if (code && code !== 0) {
      for (const other of children) {
        if (other !== child) other.kill();
      }
      process.exit(code);
    }
  });
}
