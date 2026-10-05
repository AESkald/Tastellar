import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const source = process.env.TASTELLAR_PROVIDER_CREDENTIALS_FILE
  ? resolve(process.env.TASTELLAR_PROVIDER_CREDENTIALS_FILE)
  : resolve(root, ".runtime/provider-credentials.json");
const destination = resolve(
  root,
  "apps/tastellar/src-tauri/private-provider-config",
);

let credentials;
try {
  credentials = readFileSync(source);
} catch {
  throw new Error("Could not read private provider configuration");
}

let parsed;
try {
  parsed = JSON.parse(credentials.toString("utf8"));
} catch {
  throw new Error("Private provider configuration must be a JSON array");
}
if (
  credentials.length > 64 * 1024 ||
  !Array.isArray(parsed) ||
  parsed.length !== 4
) {
  throw new Error("Private provider configuration is invalid");
}

const requiredFields = {
  tmdb: ["apiKey"],
  googleBooks: ["apiKey"],
  igdb: ["clientId", "clientSecret"],
  steam: ["apiKey", "steamId64"],
};
const providers = new Set();
for (const item of parsed) {
  const fields = requiredFields[item?.provider];
  if (
    !fields ||
    providers.has(item.provider) ||
    fields.some(
      (field) =>
        typeof item[field] !== "string" ||
        item[field].trim().length < 8 ||
        item[field].trim().length > 512,
    )
  ) {
    throw new Error("Private provider configuration is invalid");
  }
  if (
    item.provider === "steam" &&
    !/^\d{17}$/.test(item.steamId64.trim())
  ) {
    throw new Error("Private provider configuration is invalid");
  }
  providers.add(item.provider);
}
if (providers.size !== Object.keys(requiredFields).length) {
  throw new Error("Private provider configuration is invalid");
}

const mask = randomBytes(credentials.length);
const payload = Buffer.alloc(credentials.length);
for (let index = 0; index < credentials.length; index += 1) {
  payload[index] = credentials[index] ^ mask[index];
}

try {
  mkdirSync(destination, { recursive: true });
  writeFileSync(resolve(destination, "provider-data.bin"), payload, {
    mode: 0o600,
  });
  writeFileSync(resolve(destination, "provider-mask.bin"), mask, {
    mode: 0o600,
  });
} catch {
  throw new Error("Could not update bundled private provider configuration");
}

process.stdout.write("Updated bundled private provider configuration.\n");
