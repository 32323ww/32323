import { createHash, pbkdf2Sync, randomBytes } from "node:crypto";
import { getStore } from "@netlify/blobs";

const STORE_MAP = [
  ["maogai-users", "users"],
  ["maogai-progress", "progress"],
  ["maogai-question-cloud", "questions"],
  ["maogai-study-content", "content"],
  ["maogai-audit", "audit"],
  ["maogai-discussion", "discussion"]
];

const required = name => {
  const value = process.env[name];
  if (!value) throw new Error(`Missing environment variable: ${name}`);
  return value;
};

function base64Url(bytes) {
  return Buffer.from(bytes).toString("base64url");
}

function hashPassword(password, salt = base64Url(randomBytes(16))) {
  const hash = pbkdf2Sync(password, salt, 100000, 32, "sha256").toString("base64url");
  return { salt, hash };
}

function userKey(username) {
  return Buffer.from(username, "utf8").toString("base64url");
}

function chunk(items, size) {
  const batches = [];
  for (let i = 0; i < items.length; i += size) batches.push(items.slice(i, i + size));
  return batches;
}

async function mapLimit(items, limit, mapper) {
  const results = new Array(items.length);
  let index = 0;
  async function worker() {
    while (index < items.length) {
      const current = index;
      index += 1;
      results[current] = await mapper(items[current], current);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

async function fetchJson(url, options = {}) {
  const response = await fetch(url, options);
  const text = await response.text();
  let data = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { ok: false, message: text };
  }
  if (!response.ok || data.ok === false) {
    throw new Error(data.message || `HTTP ${response.status}`);
  }
  return data;
}

async function login(siteUrl, username, password) {
  const data = await fetchJson(`${siteUrl}/api/auth`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ action: "login", username, password })
  });
  return data.token;
}

async function exportNetlifyRows({ siteId, token, migrationPassword }) {
  const rows = [];
  const summary = {};
  for (const [blobStoreName, d1StoreName] of STORE_MAP) {
    const store = getStore({ name: blobStoreName, siteID: siteId, token });
    const listed = await store.list();
    const keys = listed.blobs.map(blob => blob.key);
    summary[d1StoreName] = keys.length;
    console.log(`Reading ${blobStoreName}: ${keys.length}`);
    const storeRows = await mapLimit(keys, 12, async key => {
      let value = await store.get(key, { type: "json" });
      if (d1StoreName === "users" && value?.username) {
        const hashed = hashPassword(migrationPassword);
        value = {
          ...value,
          salt: hashed.salt,
          hash: hashed.hash,
          migratedFromNetlify: true,
          migratedAt: new Date().toISOString()
        };
      }
      return { store: d1StoreName, key, value };
    });
    rows.push(...storeRows);
  }
  return { rows, summary };
}

async function main() {
  const siteId = required("NETLIFY_BLOBS_SITE_ID");
  const netlifyToken = required("NETLIFY_BLOBS_TOKEN");
  const cloudflareSite = required("CLOUDFLARE_SITE_URL").replace(/\/$/, "");
  const adminUsername = required("ADMIN_USERNAME");
  const adminPassword = required("ADMIN_PASSWORD");
  const migrationPassword = required("MIGRATION_PASSWORD");

  console.log("Exporting Netlify Blobs...");
  const { rows, summary } = await exportNetlifyRows({ siteId, token: netlifyToken, migrationPassword });
  console.log("Export summary:", summary);
  console.log(`Rows to import: ${rows.length}`);

  console.log("Logging in to Cloudflare Pages site...");
  const authToken = await login(cloudflareSite, adminUsername, adminPassword);

  let imported = 0;
  let skipped = 0;
  for (const [index, batch] of chunk(rows, 80).entries()) {
    const data = await fetchJson(`${cloudflareSite}/api/admin`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${authToken}`
      },
      body: JSON.stringify({
        action: "importNetlifyKv",
        preserveExistingUsers: true,
        rows: batch
      })
    });
    imported += data.imported || 0;
    skipped += data.skipped?.length || 0;
    console.log(`Batch ${index + 1}: imported ${data.imported || 0}, skipped ${data.skipped?.length || 0}`);
  }

  console.log("Migration complete.");
  console.log({ imported, skipped, migratedAccountTemporaryPasswordSha256: createHash("sha256").update(migrationPassword).digest("hex") });
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
