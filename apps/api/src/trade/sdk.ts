import { createRequire } from "node:module";

/**
 * @pump-fun/pump-sdk loaded through its CommonJS build: the ESM build imports an ESM dependency
 * that uses named imports from CommonJS anchor, which Node's ESM loader rejects.
 */
const require = createRequire(import.meta.url);
export const pumpSdk = require("@pump-fun/pump-sdk") as typeof import("@pump-fun/pump-sdk");
