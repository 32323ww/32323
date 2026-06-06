const TOKEN_DAYS = 30;
const LETTERS = ["A", "B", "C", "D", "E"];
const API_VERSION = "20260606-auth-char-check";
const schemaReady = new WeakSet();

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store"
    }
  });
}

function bad(message, status = 400) {
  return json({ ok: false, message }, status);
}

function plainObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function cleanText(value, limit) {
  return String(value ?? "").trim().slice(0, limit);
}

function cleanDocId(value) {
  return String(value || "").replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 120);
}

function docId(store, key) {
  return `${cleanDocId(store)}__${cleanDocId(key)}`;
}

async function ensureDb(env) {
  if (!env.DB) throw new Error("D1 binding DB is missing.");
  if (schemaReady.has(env.DB)) return;
  await env.DB.prepare(`
    CREATE TABLE IF NOT EXISTS maogai_kv (
      id TEXT PRIMARY KEY,
      store TEXT NOT NULL,
      key TEXT NOT NULL,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `).run();
  await env.DB.prepare("CREATE INDEX IF NOT EXISTS idx_maogai_kv_store ON maogai_kv(store)").run();
  schemaReady.add(env.DB);
}

async function kvGet(env, store, key) {
  const row = await env.DB
    .prepare("SELECT value FROM maogai_kv WHERE id = ?")
    .bind(docId(store, key))
    .first();
  if (!row?.value) return null;
  try {
    return JSON.parse(row.value);
  } catch {
    return null;
  }
}

async function kvSet(env, store, key, value) {
  await env.DB
    .prepare("INSERT OR REPLACE INTO maogai_kv (id, store, key, value, updated_at) VALUES (?, ?, ?, ?, ?)")
    .bind(docId(store, key), store, key, JSON.stringify(value), new Date().toISOString())
    .run();
  return value;
}

async function kvDelete(env, store, key) {
  await env.DB.prepare("DELETE FROM maogai_kv WHERE id = ?").bind(docId(store, key)).run();
}

async function kvList(env, store) {
  const result = await env.DB
    .prepare("SELECT key, value, updated_at FROM maogai_kv WHERE store = ? ORDER BY id DESC")
    .bind(store)
    .all();
  return (result.results || []).map(row => {
    try {
      return { key: row.key, value: JSON.parse(row.value), updatedAt: row.updated_at };
    } catch {
      return { key: row.key, value: null, updatedAt: row.updated_at };
    }
  });
}

async function readJson(request) {
  const text = await request.text();
  return text ? JSON.parse(text) : {};
}

function bytesToBase64Url(bytes) {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/g, "");
}

function base64UrlToBytes(value) {
  const base64 = String(value || "").replaceAll("-", "+").replaceAll("_", "/");
  const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, "=");
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function randomBase64Url(size = 16) {
  const bytes = new Uint8Array(size);
  crypto.getRandomValues(bytes);
  return bytesToBase64Url(bytes);
}

function constantTimeEqual(a, b) {
  const left = String(a || "");
  const right = String(b || "");
  if (left.length !== right.length) return false;
  let diff = 0;
  for (let i = 0; i < left.length; i += 1) diff |= left.charCodeAt(i) ^ right.charCodeAt(i);
  return diff === 0;
}

async function hashPassword(password, salt = randomBase64Url(16)) {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey("raw", encoder.encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({
    name: "PBKDF2",
    salt: base64UrlToBytes(salt),
    iterations: 100000,
    hash: "SHA-256"
  }, key, 256);
  return { salt, hash: bytesToBase64Url(new Uint8Array(bits)) };
}

async function verifyPassword(password, user) {
  const current = await hashPassword(password, user.salt);
  return constantTimeEqual(current.hash, user.hash);
}

async function verifyLegacyNetlifyLogin(env, username, password) {
  const legacyUrl = env.LEGACY_NETLIFY_AUTH_URL || "https://32323maogai.netlify.app/.netlify/functions/auth";
  try {
    const response = await fetch(legacyUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "login", username, password })
    });
    if (!response.ok) return false;
    const data = await response.json().catch(() => null);
    return Boolean(data?.ok);
  } catch {
    return false;
  }
}

async function signPayload(payload, env) {
  const encoder = new TextEncoder();
  const secret = env.AUTH_SECRET || "maogai-cloudflare-local-secret-change-me";
  const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(payload));
  return bytesToBase64Url(new Uint8Array(signature));
}

async function signToken(username, env) {
  const now = Math.floor(Date.now() / 1000);
  const payload = bytesToBase64Url(new TextEncoder().encode(JSON.stringify({
    sub: username,
    iat: now,
    exp: now + TOKEN_DAYS * 24 * 60 * 60
  })));
  return `${payload}.${await signPayload(payload, env)}`;
}

async function verifyToken(request, env) {
  const header = request.headers.get("authorization") || "";
  const token = header.replace(/^Bearer\s+/i, "").trim();
  const [payload, signature] = token.split(".");
  if (!payload || !signature || !constantTimeEqual(await signPayload(payload, env), signature)) throw new Error("Login required.");
  const parsed = JSON.parse(new TextDecoder().decode(base64UrlToBytes(payload)));
  if (!parsed.sub || parsed.exp < Math.floor(Date.now() / 1000)) throw new Error("Login expired.");
  return normalizeUsername(parsed.sub);
}

function normalizeUsername(username) {
  const value = String(username || "").trim();
  const chars = Array.from(value);
  const valid = chars.length >= 2 && chars.length <= 24 && chars.every(char => {
    const code = char.codePointAt(0);
    return char === "_" || (code >= 48 && code <= 57) || (code >= 65 && code <= 90) || (code >= 97 && code <= 122) || (code >= 0x4e00 && code <= 0x9fff);
  });
  if (!valid) throw new Error("Username must be 2-24 characters.");
  return value;
}

function validatePassword(password) {
  const value = String(password || "");
  if (value.length < 6 || value.length > 80) throw new Error("Password must be 6-80 characters.");
  return value;
}

function userKey(username) {
  return bytesToBase64Url(new TextEncoder().encode(username));
}

function adminUsers(env) {
  return new Set(String(env.ADMIN_USERS || "q1853_admin")
    .split(/[,\s;]+/)
    .map(item => item.trim())
    .filter(Boolean));
}

function isEnvAdmin(username, env) {
  return adminUsers(env).has(username);
}

async function isAdminUser(env, username) {
  if (isEnvAdmin(username, env)) return true;
  const user = await kvGet(env, "users", userKey(username));
  return Boolean(user?.isAdmin);
}

async function authContext(request, env) {
  const username = await verifyToken(request, env);
  return { username, isAdmin: await isAdminUser(env, username) };
}

async function requireAdmin(request, env) {
  const auth = await authContext(request, env);
  if (!auth.isAdmin) throw new Error("Admin required.");
  return auth;
}

function cleanStore(store = {}) {
  return {
    attempts: plainObject(store.attempts),
    wrong: plainObject(store.wrong),
    mastered: plainObject(store.mastered),
    seen: plainObject(store.seen),
    favorites: plainObject(store.favorites)
  };
}

function parseAnswer(answer) {
  const letters = Array.isArray(answer) ? answer : String(answer || "").toUpperCase().match(/[A-E]/g);
  return [...new Set((letters || []).map(item => String(item).toUpperCase()).filter(item => /^[A-E]$/.test(item)))];
}

function sanitizeQuestion(input, mode = "add") {
  const q = plainObject(input);
  const type = ["single", "multi", "judge"].includes(q.type) ? q.type : "single";
  const options = (Array.isArray(q.options) ? q.options : [])
    .map(item => cleanText(item, 220))
    .filter(Boolean)
    .slice(0, 5);
  const normalizedOptions = type === "judge" && options.length < 2 ? ["正确", "错误"] : options;
  if (normalizedOptions.length < 2) throw new Error("At least 2 options are required.");
  const answer = parseAnswer(q.answer).filter(letter => letter.charCodeAt(0) - 65 < normalizedOptions.length);
  if (!answer.length) throw new Error("Answer letters are required.");
  if (type === "single" && answer.length !== 1) throw new Error("Single choice requires exactly 1 answer.");
  if (type === "judge" && answer.length !== 1) throw new Error("Judge question requires exactly 1 answer.");

  const optionAnalysis = {};
  const rawAnalysis = plainObject(q.optionAnalysis);
  for (let i = 0; i < normalizedOptions.length; i += 1) {
    const letter = String.fromCharCode(65 + i);
    const note = cleanText(rawAnalysis[letter], 900);
    if (note) optionAnalysis[letter] = note;
  }

  const base = {
    type,
    chapter: cleanText(q.chapter || "用户题库", 24) || "用户题库",
    stem: cleanText(q.stem, 900),
    options: normalizedOptions,
    answer,
    analysis: cleanText(q.analysis, 2400),
    optionAnalysis,
    page: cleanText(q.page, 60),
    source: mode === "add" ? cleanText(q.source || "用户补充题库", 80) : cleanText(q.source, 80),
    bankId: cleanText(q.bankId, 80),
    bankName: cleanText(q.bankName, 80),
    updatedAt: new Date().toISOString()
  };
  if (!base.stem) throw new Error("Question stem is required.");
  if (!base.analysis) base.analysis = `答案：${answer.join("、")}。`;
  return base;
}

async function getQuestionCloud(env) {
  const current = await kvGet(env, "questions", "cloud");
  return current && typeof current === "object" ? {
    version: Number(current.version || 1),
    additions: Array.isArray(current.additions) ? current.additions : [],
    patches: plainObject(current.patches),
    deleted: plainObject(current.deleted),
    banks: plainObject(current.banks)
  } : { version: 1, additions: [], patches: {}, deleted: {}, banks: {} };
}

async function setQuestionCloud(env, data) {
  await kvSet(env, "questions", "cloud", {
    version: Number(data.version || 1) + 1,
    additions: Array.isArray(data.additions) ? data.additions : [],
    patches: plainObject(data.patches),
    deleted: plainObject(data.deleted),
    banks: plainObject(data.banks),
    updatedAt: new Date().toISOString()
  });
}

function publicQuestions(cloud) {
  return {
    ok: true,
    version: cloud.version,
    additions: cloud.additions,
    patches: cloud.patches,
    deleted: Object.fromEntries(Object.keys(cloud.deleted || {}).map(id => [id, true])),
    banks: cloud.banks
  };
}

function newId(prefix) {
  const stamp = Date.now().toString(36).toUpperCase();
  const rand = Math.random().toString(36).slice(2, 8).toUpperCase();
  return `${prefix}${stamp}${rand}`;
}

async function writeAudit(env, actor, action, summary, detail = {}) {
  const item = { id: newId("AU"), actor, action, summary: cleanText(summary, 500), detail, at: new Date().toISOString() };
  await kvSet(env, "audit", item.id, item);
  return item;
}

async function listAudit(env, options = {}) {
  const rows = (await kvList(env, "audit")).map(row => row.value).filter(Boolean)
    .sort((a, b) => String(b.id).localeCompare(String(a.id)));
  const pageSize = Math.max(5, Math.min(80, Number(options.pageSize || 12)));
  const total = rows.length;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const page = Math.max(1, Math.min(totalPages, Number(options.page || 1)));
  return { rows: rows.slice((page - 1) * pageSize, page * pageSize), page, pageSize, total, totalPages };
}

async function listUsers(env) {
  const rows = [];
  for (const row of await kvList(env, "users")) {
    const user = row.value;
    if (user?.username) {
      rows.push({
        username: user.username,
        createdAt: user.createdAt || "",
        isAdmin: await isAdminUser(env, user.username),
        isEnvAdmin: isEnvAdmin(user.username, env)
      });
    }
  }
  return rows.sort((a, b) => a.username.localeCompare(b.username, "zh-Hans-CN"));
}

function findCloudQuestion(cloud, id) {
  return (cloud.additions || []).find(item => item.id === id) || null;
}

function bankForQuestion(cloud, question) {
  if (!question?.bankId) return null;
  return plainObject(cloud.banks)[question.bankId] || null;
}

function canManageBank(auth, bank) {
  return auth.isAdmin || bank?.createdBy === auth.username;
}

function canManageQuestion(auth, cloud, id, mode = "edit") {
  if (auth.isAdmin) return true;
  const added = findCloudQuestion(cloud, id);
  const bank = bankForQuestion(cloud, added);
  if (mode.includes("delete")) return Boolean(added?.bankId && bank?.createdBy === auth.username);
  if (added?.createdBy === auth.username) return true;
  if (bank?.createdBy === auth.username) return true;
  if (mode === "limited-original-edit" && !added) return true;
  return false;
}

function limitedOriginalPatch(patch) {
  return {
    options: patch.options,
    answer: patch.answer,
    analysis: patch.analysis,
    optionAnalysis: patch.optionAnalysis,
    page: patch.page,
    updatedAt: patch.updatedAt
  };
}

function duplicateKey(question) {
  const compact = value => String(value || "").toLowerCase().replace(/[【】（）()《》“”"'\s，,。.:：；;、？?！!]/g, "");
  return [question.type, compact(question.stem), (question.options || []).map(compact).join("|")].join("::");
}

function existingQuestionKeys(cloud) {
  const keys = new Set();
  for (const item of cloud.additions || []) {
    if (!cloud.deleted?.[item.id]) keys.add(duplicateKey(item));
  }
  return keys;
}

function cleanBankName(value) {
  const name = String(value || "").trim().slice(0, 40);
  if (!name) throw new Error("Bank name is required.");
  return name;
}

function prepareQuestionForAdd(auth, cloud, raw) {
  const question = sanitizeQuestion(raw, "add");
  if (question.bankId) {
    const bank = cloud.banks[question.bankId];
    if (!canManageBank(auth, bank)) throw new Error("Cannot add to this bank.");
    question.bankName = bank.name;
    question.source = String(question.source || "").startsWith("用户新增题库：") ? question.source : `用户题库：${bank.name}`;
  }
  return question;
}

async function getContentCloud(env) {
  const current = await kvGet(env, "content", "cloud");
  const bucket = value => ({
    additions: Array.isArray(value?.additions) ? value.additions : [],
    patches: plainObject(value?.patches),
    deleted: plainObject(value?.deleted)
  });
  return current && typeof current === "object" ? {
    version: Number(current.version || 1),
    timeline: bucket(current.timeline),
    keypoints: bucket(current.keypoints)
  } : {
    version: 1,
    timeline: { additions: [], patches: {}, deleted: {} },
    keypoints: { additions: [], patches: {}, deleted: {} }
  };
}

async function setContentCloud(env, data) {
  await kvSet(env, "content", "cloud", {
    version: Number(data.version || 1) + 1,
    timeline: data.timeline,
    keypoints: data.keypoints,
    updatedAt: new Date().toISOString()
  });
}

function contentBucketName(type) {
  if (type === "timeline") return "timeline";
  if (type === "keypoint" || type === "keypoints") return "keypoints";
  throw new Error("Unsupported content type.");
}

function cleanOrder(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : undefined;
}

function sanitizeTimeline(input = {}) {
  const item = plainObject(input);
  const cleaned = {
    time: cleanText(item.time, 80),
    actor: cleanText(item.actor, 80),
    name: cleanText(item.name, 180),
    kind: cleanText(item.kind || "理论提法/事件", 40),
    significance: cleanText(item.significance, 800),
    page: cleanText(item.page, 40),
    chapter: cleanText(item.chapter, 120),
    chapterPages: cleanText(item.chapterPages, 40)
  };
  const order = cleanOrder(item.order);
  if (order !== undefined) cleaned.order = order;
  if (!cleaned.time || !cleaned.name || !cleaned.significance) throw new Error("Timeline fields are required.");
  const match = cleaned.time.match(/(19|20)\d{2}/);
  cleaned.year = match ? Number(match[0]) : 9999;
  return cleaned;
}

function sanitizeKeypoint(input = {}) {
  const item = plainObject(input);
  const cleaned = {
    chapter: cleanText(item.chapter, 120),
    chapterPages: cleanText(item.chapterPages, 40),
    module: cleanText(item.module, 60),
    keyword: cleanText(item.keyword, 80),
    content: cleanText(item.content, 900),
    page: cleanText(item.page, 40),
    level: cleanText(item.level || "识记", 20)
  };
  if (!cleaned.chapter || !cleaned.keyword || !cleaned.content) throw new Error("Keypoint fields are required.");
  return cleaned;
}

function sanitizeContent(type, item) {
  return contentBucketName(type) === "timeline" ? sanitizeTimeline(item) : sanitizeKeypoint(item);
}

function findAddition(bucket, id) {
  return bucket.additions.find(item => item.id === id) || null;
}

function publicContent(cloud) {
  const compress = bucket => ({
    additions: bucket.additions,
    patches: bucket.patches,
    deleted: Object.fromEntries(Object.keys(bucket.deleted || {}).map(id => [id, true]))
  });
  return { ok: true, version: cloud.version, timeline: compress(cloud.timeline), keypoints: compress(cloud.keypoints) };
}

function cleanMessage(value) {
  const text = String(value || "").trim().slice(0, 1000);
  if (!text) throw new Error("Message is required.");
  return text;
}

function normalizeAiAnswer(value, optionCount = 5) {
  const raw = Array.isArray(value) ? value.join("") : String(value || "");
  return [...new Set((raw.toUpperCase().match(/[A-E]/g) || [])
    .filter(letter => letter.charCodeAt(0) - 65 < optionCount))]
    .sort((a, b) => LETTERS.indexOf(a) - LETTERS.indexOf(b));
}

function sanitizeUploadedAiPatch(raw) {
  const item = plainObject(raw);
  const id = cleanText(item.id || item.questionId, 80);
  if (!id) throw new Error("Question id is required.");
  const patchInput = plainObject(item.patch || item);
  const optionCount = Math.max(2, Math.min(5, Number(item.optionCount || patchInput.optionCount || 5)));
  const optionAnalysis = {};
  const rawOptionAnalysis = plainObject(patchInput.optionAnalysis);
  for (let i = 0; i < optionCount; i += 1) {
    const letter = LETTERS[i];
    const text = cleanText(rawOptionAnalysis[letter], 900);
    if (text) optionAnalysis[letter] = text;
  }
  const patch = {
    analysis: cleanText(patchInput.analysis, 2400),
    optionAnalysis,
    aiAnswer: normalizeAiAnswer(patchInput.aiAnswer || patchInput.answer, optionCount),
    aiModel: cleanText(patchInput.aiModel || patchInput.model, 120),
    aiCheckedAt: cleanText(patchInput.aiCheckedAt, 80) || new Date().toISOString(),
    aiConfidence: cleanText(patchInput.aiConfidence || patchInput.confidence, 20),
    disputed: Boolean(patchInput.disputed),
    disputeNote: cleanText(patchInput.disputeNote, 600),
    updatedAt: new Date().toISOString()
  };
  if (!patch.analysis && !Object.keys(optionAnalysis).length) throw new Error("AI analysis is required.");
  return { id, patch };
}

async function handleAuth(request, env) {
  if (request.method === "GET") {
    const auth = await authContext(request, env);
    return json({ ok: true, user: { username: auth.username, isAdmin: auth.isAdmin } });
  }
  if (request.method !== "POST") return bad("Method not allowed.", 405);
  const body = await readJson(request);
  const action = String(body.action || "").trim();

  if (action === "changePassword") {
    const auth = await authContext(request, env);
    const currentPassword = validatePassword(body.currentPassword);
    const newPassword = validatePassword(body.newPassword);
    const key = userKey(auth.username);
    const user = await kvGet(env, "users", key);
    if (!user) return bad("Account not found.", 404);
    let verified = await verifyPassword(currentPassword, user);
    if (!verified) {
      verified = await verifyLegacyNetlifyLogin(env, auth.username, currentPassword);
    }
    if (!verified) return bad("Current password is wrong.", 401);
    const hashed = await hashPassword(newPassword);
    user.salt = hashed.salt;
    user.hash = hashed.hash;
    user.passwordChangedAt = new Date().toISOString();
    user.passwordChangedBy = auth.username;
    await kvSet(env, "users", key, user);
    await writeAudit(env, auth.username, "account:password-change", `change own password: ${auth.username}`, { username: auth.username });
    return json({ ok: true, user: { username: auth.username, isAdmin: await isAdminUser(env, auth.username), passwordChangedAt: user.passwordChangedAt } });
  }

  const username = normalizeUsername(body.username);
  const password = validatePassword(body.password);
  const key = userKey(username);
  const existing = await kvGet(env, "users", key);

  if (action === "register") {
    if (existing) return bad("Account already exists.", 409);
    const hashed = await hashPassword(password);
    await kvSet(env, "users", key, { username, salt: hashed.salt, hash: hashed.hash, createdAt: new Date().toISOString() });
    return json({ ok: true, user: { username, isAdmin: await isAdminUser(env, username) }, token: await signToken(username, env) });
  }
  if (action === "login") {
    if (!existing) return bad("Wrong username or password.", 401);
    const storedName = existing.username || username;
    if (!(await verifyPassword(password, existing))) {
      const legacyOk = await verifyLegacyNetlifyLogin(env, storedName, password);
      if (!legacyOk) return bad("Wrong username or password.", 401);
      const migrated = await hashPassword(password);
      existing.salt = migrated.salt;
      existing.hash = migrated.hash;
      existing.passwordMigratedFromNetlifyAt = new Date().toISOString();
      await kvSet(env, "users", key, existing);
      await writeAudit(env, storedName, "account:password-lazy-migrate", `migrate password from Netlify: ${storedName}`, { username: storedName });
    }
    return json({ ok: true, user: { username: storedName, isAdmin: await isAdminUser(env, storedName) }, token: await signToken(storedName, env) });
  }
  return bad("Unknown action.", 400);
}

async function handleProgress(request, env) {
  const username = await verifyToken(request, env);
  if (request.method === "GET") {
    const progress = await kvGet(env, "progress", userKey(username));
    return json({ ok: true, store: cleanStore(progress?.store || progress || {}) });
  }
  if (request.method === "PUT") {
    const body = await readJson(request);
    const cleaned = cleanStore(body.store || body);
    await kvSet(env, "progress", userKey(username), { store: cleaned, updatedAt: new Date().toISOString() });
    return json({ ok: true, store: cleaned });
  }
  return bad("Method not allowed.", 405);
}

async function handleQuestions(request, env, url) {
  if (request.method === "GET") return json(publicQuestions(await getQuestionCloud(env)));
  const auth = await authContext(request, env);
  const body = await readJson(request);
  const cloud = await getQuestionCloud(env);

  if (request.method === "POST") {
    if (body.action === "createBank") {
      const bank = { id: newId("BK"), name: cleanBankName(body.name), createdBy: auth.username, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
      cloud.banks[bank.id] = bank;
      await setQuestionCloud(env, cloud);
      await writeAudit(env, auth.username, "bank:create", `create bank: ${bank.name}`, { bank });
      return json({ ok: true, bank });
    }
    if (body.action === "bulkImport") {
      const rawQuestions = Array.isArray(body.questions) ? body.questions : [];
      if (!rawQuestions.length) return bad("No questions to import.", 400);
      const keys = existingQuestionKeys(cloud);
      const imported = [];
      const skipped = [];
      for (const raw of rawQuestions.slice(0, 200)) {
        const question = prepareQuestionForAdd(auth, cloud, raw);
        const key = duplicateKey(question);
        if (keys.has(key)) {
          skipped.push({ stem: question.stem, reason: "duplicate" });
          continue;
        }
        keys.add(key);
        const item = { ...question, id: newId("UQ"), createdBy: auth.username, createdAt: new Date().toISOString() };
        cloud.additions.push(item);
        imported.push(item);
      }
      if (imported.length) await setQuestionCloud(env, cloud);
      await writeAudit(env, auth.username, "question:bulk-import", `bulk import: ${imported.length}, skipped: ${skipped.length}`, { importedCount: imported.length, skipped });
      return json({ ok: true, imported, skipped });
    }
    const question = prepareQuestionForAdd(auth, cloud, body.question || body);
    if (existingQuestionKeys(cloud).has(duplicateKey(question))) return bad("Duplicate question.", 409);
    const item = { ...question, id: newId("UQ"), createdBy: auth.username, createdAt: new Date().toISOString() };
    cloud.additions.push(item);
    await setQuestionCloud(env, cloud);
    await writeAudit(env, auth.username, "question:add", `add question: ${item.stem.slice(0, 80)}`, { after: item });
    return json({ ok: true, question: item });
  }

  if (request.method === "PUT") {
    if (body.action === "updateBank") {
      const bank = cloud.banks[String(body.bankId || "")];
      if (!bank) return bad("Bank not found.", 404);
      if (!canManageBank(auth, bank)) return bad("Cannot edit this bank.", 403);
      const before = { ...bank };
      bank.name = cleanBankName(body.name);
      bank.updatedAt = new Date().toISOString();
      bank.updatedBy = auth.username;
      cloud.banks[bank.id] = bank;
      cloud.additions = cloud.additions.map(item => item.bankId === bank.id ? { ...item, bankName: bank.name, source: `用户题库：${bank.name}` } : item);
      await setQuestionCloud(env, cloud);
      await writeAudit(env, auth.username, "bank:update", `update bank: ${bank.name}`, { before, after: bank });
      return json({ ok: true, bank });
    }
    const id = String(body.id || "").trim();
    if (!id) return bad("Question id is required.", 400);
    const existingAddition = findCloudQuestion(cloud, id);
    const fullPatch = sanitizeQuestion(body.patch || body.question || body, "edit");
    if (!canManageQuestion(auth, cloud, id, existingAddition ? "cloud-edit" : "limited-original-edit")) return bad("Cannot edit this question.", 403);
    let patch = fullPatch;
    if (!auth.isAdmin && !existingAddition) patch = limitedOriginalPatch(fullPatch);
    if (patch.bankId) {
      const bank = cloud.banks[patch.bankId];
      if (!canManageBank(auth, bank)) return bad("Cannot move question to this bank.", 403);
      patch.bankName = bank.name;
      patch.source = `用户题库：${bank.name}`;
    }
    let before = null;
    let after = null;
    if (existingAddition) {
      before = { ...existingAddition };
      Object.assign(existingAddition, patch, { updatedBy: auth.username, updatedAt: new Date().toISOString() });
      after = existingAddition;
    } else {
      before = plainObject(cloud.patches[id]);
      cloud.patches[id] = { ...plainObject(cloud.patches[id]), ...patch, updatedBy: auth.username, updatedAt: new Date().toISOString() };
      after = cloud.patches[id];
    }
    delete cloud.deleted[id];
    await setQuestionCloud(env, cloud);
    await writeAudit(env, auth.username, "question:update", `update question: ${id}`, { id, before, after });
    return json({ ok: true, id, patch: after });
  }

  if (request.method === "DELETE") {
    if (body.action === "deleteBank") {
      const bank = cloud.banks[String(body.bankId || "")];
      if (!bank) return bad("Bank not found.", 404);
      if (!canManageBank(auth, bank)) return bad("Cannot delete this bank.", 403);
      const deletedAt = new Date().toISOString();
      const before = { ...bank };
      const deletedQuestions = [];
      for (const item of cloud.additions || []) {
        if (item.bankId === bank.id) {
          cloud.deleted[item.id] = { id: item.id, deletedBy: auth.username, deletedAt, reason: `delete bank: ${bank.name}` };
          deletedQuestions.push(item.id);
        }
      }
      delete cloud.banks[bank.id];
      await setQuestionCloud(env, cloud);
      await writeAudit(env, auth.username, "bank:delete", `delete bank: ${before.name}`, { before, deletedQuestions });
      return json({ ok: true, bankId: before.id, deletedQuestions });
    }
    const id = String(body.id || url.searchParams.get("id") || "").trim();
    if (!id) return bad("Question id is required.", 400);
    const existingAddition = findCloudQuestion(cloud, id);
    if (!canManageQuestion(auth, cloud, id, existingAddition ? "cloud-delete" : "delete")) return bad("Cannot delete this question.", 403);
    const before = existingAddition || plainObject(cloud.patches[id]);
    cloud.deleted[id] = { id, deletedBy: auth.username, deletedAt: new Date().toISOString(), reason: cleanText(body.reason, 200) };
    await setQuestionCloud(env, cloud);
    await writeAudit(env, auth.username, "question:delete", `delete question: ${id}`, { id, before, deleted: cloud.deleted[id] });
    return json({ ok: true, id });
  }

  return bad("Method not allowed.", 405);
}

async function handleContent(request, env, url) {
  if (request.method === "GET") return json(publicContent(await getContentCloud(env)));
  const auth = await authContext(request, env);
  const body = await readJson(request);
  const cloud = await getContentCloud(env);
  const name = contentBucketName(body.type);
  const bucket = cloud[name];

  if (request.method === "POST") {
    const item = { ...sanitizeContent(body.type, body.item || body), id: newId(name === "timeline" ? "TLU" : "KPU"), createdBy: auth.username, createdAt: new Date().toISOString() };
    bucket.additions.push(item);
    await setContentCloud(env, cloud);
    await writeAudit(env, auth.username, `content:${name}:add`, `add ${name}: ${item.name || item.keyword}`, { item });
    return json({ ok: true, item });
  }
  if (request.method === "PUT") {
    const id = cleanText(body.id, 80);
    if (!id) return bad("Content id is required.", 400);
    const patch = { ...sanitizeContent(body.type, body.patch || body.item || body), updatedBy: auth.username, updatedAt: new Date().toISOString() };
    const added = findAddition(bucket, id);
    let before = null;
    let after = null;
    if (added) {
      before = { ...added };
      Object.assign(added, patch);
      after = added;
    } else {
      before = plainObject(bucket.patches[id]);
      bucket.patches[id] = { ...plainObject(bucket.patches[id]), ...patch };
      after = bucket.patches[id];
    }
    delete bucket.deleted[id];
    await setContentCloud(env, cloud);
    await writeAudit(env, auth.username, `content:${name}:update`, `update ${name}: ${id}`, { id, before, after });
    return json({ ok: true, id, patch: after });
  }
  if (request.method === "DELETE") {
    const id = cleanText(body.id || url.searchParams.get("id"), 80);
    if (!id) return bad("Content id is required.", 400);
    bucket.deleted[id] = { id, deletedBy: auth.username, deletedAt: new Date().toISOString() };
    await setContentCloud(env, cloud);
    await writeAudit(env, auth.username, `content:${name}:delete`, `delete ${name}: ${id}`, { id });
    return json({ ok: true, id });
  }
  return bad("Method not allowed.", 405);
}

async function handleDiscussion(request, env, url) {
  if (request.method === "GET") {
    const limit = Math.max(1, Math.min(200, Number(url.searchParams.get("limit") || 120)));
    const posts = (await kvList(env, "discussion")).map(row => row.value).filter(item => item && !item.deletedAt)
      .sort((a, b) => {
        if (Boolean(a.pinned) !== Boolean(b.pinned)) return a.pinned ? -1 : 1;
        return Date.parse(b.pinnedAt || b.createdAt || "") - Date.parse(a.pinnedAt || a.createdAt || "");
      })
      .slice(0, limit);
    return json({ ok: true, posts });
  }

  const auth = await authContext(request, env);
  const body = await readJson(request);

  if (request.method === "POST") {
    if (body.action === "pin") {
      if (!auth.isAdmin) return bad("Only admins can pin posts.", 403);
      const postId = String(body.id || body.postId || "").trim();
      const post = await kvGet(env, "discussion", postId);
      if (!post || post.deletedAt) return bad("Post not found.", 404);
      const before = { pinned: Boolean(post.pinned), pinnedAt: post.pinnedAt || "" };
      post.pinned = Boolean(body.pinned);
      post.pinnedAt = post.pinned ? new Date().toISOString() : "";
      post.pinnedBy = post.pinned ? auth.username : "";
      await kvSet(env, "discussion", postId, post);
      await writeAudit(env, auth.username, post.pinned ? "discussion:pin" : "discussion:unpin", `${post.pinned ? "pin" : "unpin"} post: ${postId}`, { postId, before, after: { pinned: post.pinned, pinnedAt: post.pinnedAt } });
      return json({ ok: true, post });
    }
    if (body.action === "reply") {
      const postId = String(body.postId || "").trim();
      const post = await kvGet(env, "discussion", postId);
      if (!post || post.deletedAt) return bad("Post not found.", 404);
      const reply = { id: newId("RP"), author: auth.username, message: cleanMessage(body.message), createdAt: new Date().toISOString() };
      post.replies = Array.isArray(post.replies) ? post.replies : [];
      post.replies.push(reply);
      await kvSet(env, "discussion", postId, post);
      await writeAudit(env, auth.username, "discussion:reply", `reply post: ${postId}`, { postId, reply });
      return json({ ok: true, reply });
    }
    const post = { id: newId("DS"), author: auth.username, message: cleanMessage(body.message), createdAt: new Date().toISOString(), replies: [] };
    await kvSet(env, "discussion", post.id, post);
    await writeAudit(env, auth.username, "discussion:add", `add post: ${post.message.slice(0, 80)}`, { post });
    return json({ ok: true, post });
  }

  if (request.method === "DELETE") {
    const id = String(body.id || url.searchParams.get("id") || "").trim();
    const before = await kvGet(env, "discussion", id);
    if (!before) return bad("Post not found.", 404);
    const replyId = String(body.replyId || url.searchParams.get("replyId") || "").trim();
    if (replyId) {
      const replies = Array.isArray(before.replies) ? before.replies : [];
      const index = replies.findIndex(reply => reply.id === replyId);
      if (index < 0) return bad("Reply not found.", 404);
      if (!auth.isAdmin && replies[index].author !== auth.username) return bad("Cannot delete this reply.", 403);
      const deletedReply = { ...replies[index], deletedAt: new Date().toISOString(), deletedBy: auth.username };
      replies[index] = deletedReply;
      await kvSet(env, "discussion", id, { ...before, replies });
      await writeAudit(env, auth.username, "discussion:reply-delete", `delete reply: ${replyId}`, { postId: id, deletedReply });
      return json({ ok: true });
    }
    if (!auth.isAdmin && before.author !== auth.username) return bad("Cannot delete this post.", 403);
    const deleted = { ...before, deletedAt: new Date().toISOString(), deletedBy: auth.username };
    await kvSet(env, "discussion", id, deleted);
    await writeAudit(env, auth.username, "discussion:delete", `delete post: ${id}`, { before, deleted });
    return json({ ok: true });
  }
  return bad("Method not allowed.", 405);
}

async function handleAdmin(request, env, url) {
  const auth = await requireAdmin(request, env);
  if (request.method === "GET") {
    const action = String(url.searchParams.get("action") || "summary");
    const pageData = await listAudit(env, {
      page: url.searchParams.get("auditPage") || url.searchParams.get("page") || 1,
      pageSize: url.searchParams.get("auditPageSize") || url.searchParams.get("pageSize") || 12
    });
    if (action === "users") return json({ ok: true, users: await listUsers(env) });
    if (action === "audit") return json({ ok: true, audit: pageData.rows, auditPage: pageData.page, auditPageSize: pageData.pageSize, auditTotal: pageData.total, auditTotalPages: pageData.totalPages });
    return json({ ok: true, users: await listUsers(env), audit: pageData.rows, auditPage: pageData.page, auditPageSize: pageData.pageSize, auditTotal: pageData.total, auditTotalPages: pageData.totalPages });
  }
  if (request.method !== "POST") return bad("Method not allowed.", 405);

  const body = await readJson(request);
  const action = String(body.action || "").trim();
  if (action === "createUser") {
    const username = normalizeUsername(body.username);
    const password = validatePassword(body.password);
    const key = userKey(username);
    if (await kvGet(env, "users", key)) return bad("Account already exists.", 409);
    const hashed = await hashPassword(password);
    const user = { username, salt: hashed.salt, hash: hashed.hash, createdAt: new Date().toISOString(), createdBy: auth.username };
    await kvSet(env, "users", key, user);
    await writeAudit(env, auth.username, "account:create", `create account: ${username}`, { username });
    return json({ ok: true, user: { username, createdAt: user.createdAt, isAdmin: await isAdminUser(env, username), isEnvAdmin: isEnvAdmin(username, env) } });
  }
  if (action === "setAdmin") {
    const username = normalizeUsername(body.username);
    const enabled = Boolean(body.isAdmin);
    if (username === auth.username && !enabled) return bad("Cannot revoke current account.", 400);
    if (isEnvAdmin(username, env) && !enabled) return bad("Cannot revoke env admin.", 400);
    const key = userKey(username);
    const user = await kvGet(env, "users", key);
    if (!user) return bad("Account not found.", 404);
    const before = { username, isAdmin: await isAdminUser(env, username), isEnvAdmin: isEnvAdmin(username, env) };
    user.isAdmin = enabled;
    user.adminUpdatedAt = new Date().toISOString();
    user.adminUpdatedBy = auth.username;
    await kvSet(env, "users", key, user);
    const after = { username, createdAt: user.createdAt, isAdmin: await isAdminUser(env, username), isEnvAdmin: isEnvAdmin(username, env) };
    await writeAudit(env, auth.username, enabled ? "account:admin-grant" : "account:admin-revoke", `${enabled ? "grant admin" : "revoke admin"}: ${username}`, { before, after });
    return json({ ok: true, user: after });
  }
  if (action === "resetPassword") {
    const username = normalizeUsername(body.username);
    const password = validatePassword(body.password);
    const key = userKey(username);
    const user = await kvGet(env, "users", key);
    if (!user) return bad("Account not found.", 404);
    const hashed = await hashPassword(password);
    const before = {
      username,
      isAdmin: await isAdminUser(env, username),
      isEnvAdmin: isEnvAdmin(username, env),
      passwordResetAt: user.passwordResetAt || "",
      migratedFromNetlify: Boolean(user.migratedFromNetlify)
    };
    user.salt = hashed.salt;
    user.hash = hashed.hash;
    user.passwordResetAt = new Date().toISOString();
    user.passwordResetBy = auth.username;
    user.migratedFromNetlify = Boolean(user.migratedFromNetlify);
    await kvSet(env, "users", key, user);
    await writeAudit(env, auth.username, "account:password-reset", `reset password: ${username}`, { before, after: { username, passwordResetAt: user.passwordResetAt } });
    return json({ ok: true, user: { username, createdAt: user.createdAt || "", isAdmin: await isAdminUser(env, username), isEnvAdmin: isEnvAdmin(username, env), passwordResetAt: user.passwordResetAt } });
  }
  if (action === "deleteUser") {
    const username = normalizeUsername(body.username);
    if (username === auth.username) return bad("Cannot delete current account.", 400);
    if (await isAdminUser(env, username)) return bad("Revoke admin before deleting account.", 400);
    await kvDelete(env, "users", userKey(username));
    await kvDelete(env, "progress", userKey(username));
    await writeAudit(env, auth.username, "account:delete", `delete account: ${username}`, { username });
    return json({ ok: true });
  }
  if (action === "importNetlifyKv") {
    const rows = Array.isArray(body.rows) ? body.rows.slice(0, 5000) : [];
    if (!rows.length) return bad("No rows to import.", 400);
    const allowedStores = new Set(["users", "progress", "questions", "content", "audit", "discussion"]);
    let imported = 0;
    const skipped = [];
    for (const row of rows) {
      const store = String(row?.store || "").trim();
      const key = String(row?.key || "").trim();
      if (!allowedStores.has(store) || !key) {
        skipped.push({ store, key, reason: "invalid row" });
        continue;
      }
      if (store === "users" && body.preserveExistingUsers !== false && await kvGet(env, "users", key)) {
        skipped.push({ store, key, reason: "existing user preserved" });
        continue;
      }
      await kvSet(env, store, key, row.value);
      imported += 1;
    }
    await writeAudit(env, auth.username, "migration:netlify-import", `import Netlify rows: ${imported}, skipped: ${skipped.length}`, { imported, skipped });
    return json({ ok: true, imported, skipped });
  }
  return bad("Unknown action.", 400);
}

async function handleAiReview(request, env) {
  const auth = await requireAdmin(request, env);
  if (request.method !== "POST") return bad("Method not allowed.", 405);
  const body = await readJson(request);
  if (body.action !== "upload") return bad("Cloudflare version currently supports local AI patch upload only.", 400);
  const uploads = Array.isArray(body.patches) ? body.patches.slice(0, 100) : [];
  if (!uploads.length) return bad("No AI patches to upload.", 400);
  const cloud = await getQuestionCloud(env);
  const results = [];
  let success = 0;
  let disputed = 0;
  for (const rawPatch of uploads) {
    try {
      const { id, patch } = sanitizeUploadedAiPatch(rawPatch);
      cloud.patches[id] = { ...plainObject(cloud.patches[id]), ...patch, updatedBy: auth.username };
      success += 1;
      if (patch.disputed) disputed += 1;
      results.push({ id, ok: true, disputed: patch.disputed, aiAnswer: patch.aiAnswer });
    } catch (error) {
      results.push({ id: cleanText(rawPatch?.id, 80), ok: false, message: error.message || "AI patch failed." });
    }
  }
  if (success) await setQuestionCloud(env, cloud);
  await writeAudit(env, auth.username, "ai-review:upload", `upload AI analysis: ${success}, disputed: ${disputed}`, { success, disputed, results });
  return json({ ok: true, success, disputed, results });
}

export async function onRequest({ request, env }) {
  try {
    if (request.method === "OPTIONS") return new Response(null, { status: 204 });
    await ensureDb(env);
    const url = new URL(request.url);
    const path = url.pathname.replace(/^\/api/, "") || "/";
    if (path === "/" || path === "") return json({ ok: true, service: "maogai-cloudflare-api", version: API_VERSION });
    if (path === "/auth") return await handleAuth(request, env);
    if (path === "/progress") return await handleProgress(request, env);
    if (path === "/questions") return await handleQuestions(request, env, url);
    if (path === "/content") return await handleContent(request, env, url);
    if (path === "/discussion") return await handleDiscussion(request, env, url);
    if (path === "/admin") return await handleAdmin(request, env, url);
    if (path === "/ai-review") return await handleAiReview(request, env);
    return bad("Not found.", 404);
  } catch (error) {
    const message = error.message || "API error.";
    const status = message === "Login required." || message === "Login expired."
      ? 401
      : (message === "Admin required." ? 403 : 400);
    return bad(message, status);
  }
}
