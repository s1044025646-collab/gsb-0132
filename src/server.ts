import { createServer, type Server } from "node:http";
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { openDatabase } from "./db/database.ts";
import { Store } from "./store.ts";
import { createApi } from "./api/app.ts";

export interface StartedServer {
  server: Server;
  port: number;
  close: () => Promise<void>;
}

export async function startServer(options: {
  dbPath?: string;
  port?: number;
  writePortFile?: boolean;
  now?: () => Date;
} = {}): Promise<StartedServer> {
  const projectRoot = process.cwd();
  const dbPath = options.dbPath ?? join(projectRoot, "data", "midi.db");
  mkdirSync(join(projectRoot, "data"), { recursive: true });
  const db = openDatabase(dbPath, options.now);
  const store = new Store(db, options.now);
  const api = createApi(store);
  const server = createServer(api);

  // Bind loopback only and default to an OS-assigned ephemeral port.
  const requestedPort = options.port ?? Number(process.env.PORT ?? 0);
  await new Promise<void>((resolve) => {
    server.listen(requestedPort, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (typeof address !== "object" || address === null) {
    throw new Error("Failed to acquire server address");
  }
  const port = address.port;
  if (options.writePortFile !== false) {
    writeFileSync(
      join(projectRoot, "data", "server.json"),
      JSON.stringify({ host: "127.0.0.1", port, pid: process.pid, startedAt: new Date().toISOString() }, null, 2),
    );
  }
  return {
    server,
    port,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((err) => {
          if (err) reject(err);
          else {
            db.close();
            resolve();
          }
        });
      }),
  };
}

const isMain = process.argv[1] && /server\.ts$/.test(process.argv[1]);
if (isMain) {
  const started = await startServer();
  console.log(`midi-mapper listening on http://127.0.0.1:${started.port}`);
  console.log("PID", process.pid, "- state in ./data; stop with Ctrl+C or: npm run stop");
  const shutdown = () => {
    void started.close().then(() => process.exit(0));
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}
