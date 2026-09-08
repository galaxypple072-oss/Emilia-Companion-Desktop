import { createPairingCode } from "../../../packages/companion-relay-protocol/src/index.js";

const requested = process.argv.slice(2).find((argument) => argument.startsWith("--device="))?.slice("--device=".length);
const deviceId = requested || `core-${crypto.randomUUID()}`;
console.log(createPairingCode(deviceId));
