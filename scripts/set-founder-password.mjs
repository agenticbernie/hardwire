import { spawn, spawnSync } from "node:child_process";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { passwordHash } from "../apps/api/src/auth.ts";

if (!stdin.isTTY || !stdout.isTTY) {
  console.error("Run `npm run founder:password` from an interactive terminal.");
  process.exit(1);
}

const echoOff = spawnSync("stty", ["-echo"], { stdio: "inherit" });
if (echoOff.error || echoOff.status !== 0) {
  console.error("Could not disable terminal echo; no password was read.");
  process.exit(1);
}

let password = "";
let confirmation = "";
let interfaceClosed = false;
const restoreEcho = () => {
  if (interfaceClosed) return;
  interfaceClosed = true;
  spawnSync("stty", ["echo"], { stdio: "inherit" });
  stdout.write("\n");
};

try {
  const prompts = createInterface({ input: stdin, output: stdout, terminal: true });
  try {
    password = await prompts.question("New founder password (input hidden): ");
    confirmation = await prompts.question("Confirm password (input hidden): ");
  } finally {
    prompts.close();
  }
} finally {
  restoreEcho();
}

if (password.length < 12 || password.length > 1024) {
  console.error("Choose a password between 12 and 1024 characters.");
  process.exit(1);
}
if (password !== confirmation) {
  console.error("The passwords did not match; no secret was changed.");
  process.exit(1);
}

const digest = await passwordHash(password);
password = "";
confirmation = "";

const wrangler = spawn("./node_modules/.bin/wrangler", [
  "secret",
  "put",
  "FOUNDER_PASSWORD_HASH",
  "--config",
  "apps/api/wrangler.jsonc",
], { stdio: ["pipe", "inherit", "inherit"] });
wrangler.stdin.end(`${digest}\n`);

const exitCode = await new Promise((resolve, reject) => {
  wrangler.once("error", reject);
  wrangler.once("close", (code) => resolve(code ?? 1));
});
if (exitCode !== 0) process.exitCode = exitCode;
else console.log("FOUNDER_PASSWORD_HASH configured on hardwire-app.");
