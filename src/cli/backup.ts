import { loadConfig } from "../config";
import { openStore } from "../store";

async function main(): Promise<void> {
  const destination = process.argv[2];
  if (!destination) {
    console.error("usage: npm run backup -- <destination.sqlite>");
    process.exit(1);
  }
  const config = loadConfig(process.env);
  const store = openStore(config.databasePath);
  try {
    await store.db.backup(destination);
  } finally {
    store.close();
  }
  console.log("backup written");
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "backup failed";
  if (message.startsWith("Missing required") || message.includes("must be") || message.includes("placeholder")) {
    console.error(message);
  } else {
    console.error("backup failed");
  }
  process.exit(1);
});
