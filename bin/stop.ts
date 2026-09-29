import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";

// Stops only the server process previously started by this project, using the
// PID recorded in ./data/server.json. Nothing outside this project is touched.
const file = join(process.cwd(), "data", "server.json");
if (!existsSync(file)) {
  console.log("No running midi-mapper server recorded (data/server.json missing).");
  process.exit(0);
}
const info = JSON.parse(readFileSync(file, "utf8")) as { pid: number; port: number };
try {
  process.kill(info.pid, "SIGTERM");
  console.log(`Sent SIGTERM to midi-mapper pid=${info.pid} (was on port ${info.port}).`);
} catch (e) {
  console.log(`Process ${info.pid} was not running (${(e as Error).message}).`);
}
rmSync(file, { force: true });
