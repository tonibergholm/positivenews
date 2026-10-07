/**
 * Loads .env.local, then .env. Import this first in scripts, because
 * modules such as prisma.ts read the environment at import time.
 */
import { config } from "dotenv";

config({ path: [".env.local", ".env"], quiet: true });
