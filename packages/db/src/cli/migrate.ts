import { connectDb } from "../connect.js";
import { migrate } from "../migrate.js";

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL is not set");
  process.exit(1);
}
const db = await connectDb(url);
try {
  const applied = await migrate(db, { log: (msg) => console.log(`[migrate] ${msg}`) });
  console.log(applied.length ? `[migrate] ${applied.length} migration(s) applied` : "[migrate] up to date");
} finally {
  await db.close();
}
