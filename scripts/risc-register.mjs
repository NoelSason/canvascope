#!/usr/bin/env node
// Register / inspect / test the Cross-Account Protection (RISC) event stream.
//
// Mints a service-account-signed bearer JWT (no network round-trip, no extra
// deps — uses node:crypto) and calls Google's RISC management API.
//
// Prereqs (see docs/risc-setup or the chat summary):
//   1. A service account with role roles/riscconfigs.admin in the SAME GCP
//      project as your Google OAuth client, with a downloaded JSON key.
//   2. The RISC API enabled on that project (and RISC Terms accepted).
//
// Usage:
//   GOOGLE_APPLICATION_CREDENTIALS=/path/to/sa-key.json \
//     node scripts/risc-register.mjs update https://<ref>.functions.supabase.co/risc-receiver
//   node scripts/risc-register.mjs get
//   node scripts/risc-register.mjs verify "hello-from-canvascope"
//   node scripts/risc-register.mjs status enabled|disabled
//
// The key path can also be passed with --key /path/to/sa-key.json.

import { readFileSync } from "node:fs";
import { createSign } from "node:crypto";

const RISC_AUDIENCE = "https://risc.googleapis.com/google.identity.risc.v1beta.RiscManagementService";
const API_BASE = "https://risc.googleapis.com/v1beta";

// Security event types we subscribe to. Pared to the security-relevant set the
// risc-receiver function actually handles.
const EVENTS_REQUESTED = [
  "https://schemas.openid.net/secevent/risc/event-type/sessions-revoked",
  "https://schemas.openid.net/secevent/oauth/event-type/tokens-revoked",
  "https://schemas.openid.net/secevent/oauth/event-type/token-revoked",
  "https://schemas.openid.net/secevent/risc/event-type/account-disabled",
  "https://schemas.openid.net/secevent/risc/event-type/account-enabled",
  "https://schemas.openid.net/secevent/risc/event-type/account-credential-change-required",
  "https://schemas.openid.net/secevent/risc/event-type/verification",
];

function b64url(input) {
  return Buffer.from(input).toString("base64").replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
}

function loadKeyPath(args) {
  const flagIdx = args.indexOf("--key");
  if (flagIdx !== -1 && args[flagIdx + 1]) return args[flagIdx + 1];
  if (process.env.GOOGLE_APPLICATION_CREDENTIALS) return process.env.GOOGLE_APPLICATION_CREDENTIALS;
  throw new Error("Provide the service-account JSON key via GOOGLE_APPLICATION_CREDENTIALS or --key <path>");
}

function makeBearer(keyPath) {
  const sa = JSON.parse(readFileSync(keyPath, "utf8"));
  if (sa.type !== "service_account" || !sa.private_key) {
    throw new Error(`${keyPath} is not a service-account key JSON`);
  }
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: "RS256", typ: "JWT", kid: sa.private_key_id };
  const claims = {
    iss: sa.client_email,
    sub: sa.client_email,
    aud: RISC_AUDIENCE,
    iat: now,
    exp: now + 3600,
  };
  const signingInput = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(claims))}`;
  const signature = createSign("RSA-SHA256").update(signingInput).sign(sa.private_key);
  return `${signingInput}.${b64url(signature)}`;
}

async function call(method, path, bearer, body) {
  const res = await fetch(`${API_BASE}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${bearer}`,
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  console.log(`${method} ${path} -> ${res.status}`);
  if (text) {
    try { console.log(JSON.stringify(JSON.parse(text), null, 2)); }
    catch { console.log(text); }
  }
  if (!res.ok) process.exitCode = 1;
}

async function main() {
  const rawArgs = process.argv.slice(2);
  const keyPath = loadKeyPath(rawArgs);

  // Strip the `--key <path>` flag so the remaining positionals are the command.
  const positionals = [];
  for (let i = 0; i < rawArgs.length; i++) {
    if (rawArgs[i] === "--key") { i++; continue; }
    positionals.push(rawArgs[i]);
  }
  const [cmd, arg] = positionals;
  const bearer = makeBearer(keyPath);

  switch (cmd) {
    case "update": {
      if (!arg) throw new Error("Usage: risc-register.mjs update <receiver-https-url>");
      await call("POST", "/stream:update", bearer, {
        delivery: {
          delivery_method: "https://schemas.openid.net/secevent/risc/delivery-method/push",
          url: arg,
        },
        events_requested: EVENTS_REQUESTED,
      });
      break;
    }
    case "get":
      await call("GET", "/stream", bearer);
      break;
    case "verify":
      await call("POST", "/stream:verify", bearer, { state: arg ?? `canvascope-${Date.now()}` });
      break;
    case "status":
      if (arg !== "enabled" && arg !== "disabled") throw new Error("Usage: risc-register.mjs status enabled|disabled");
      await call("POST", "/stream/status:update", bearer, { status: arg });
      break;
    default:
      console.error("Commands: update <url> | get | verify [state] | status <enabled|disabled>");
      process.exit(2);
  }
}

main().catch((err) => { console.error(err.message); process.exit(1); });
