const { createHmac, pbkdf2Sync, randomBytes, timingSafeEqual } = require("node:crypto");
const { getStore } = require("@netlify/blobs");

const TOKEN_DAYS = 30;
const MAX_BODY_BYTES = 900_000;
const USERNAME_RE = /^[\p{Script=Han}A-Za-z0-9_]{2,24}$/u;

function json(data, status = 200) {
  return {
    statusCode: status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store"
    },
    body: JSON.stringify(data)
  };
}

function bad(message, status = 400) {
  return json({ ok: false, message }, status);
}

function readJson(event) {
  const text = event.body || "";
  if (text.length > MAX_BODY_BYTES) throw new Error("请求内容过大");
  return text ? JSON.parse(text) : {};
}

function normalizeUsername(username) {
  const value = String(username || "").trim();
  if (!USERNAME_RE.test(value)) {
    throw new Error("账号需为 2-24 位中文、字母、数字或下划线");
  }
  return value;
}

function validatePassword(password) {
  const value = String(password || "");
  if (value.length < 6 || value.length > 80) {
    throw new Error("密码需为 6-80 位");
  }
  return value;
}

function userKey(username) {
  return Buffer.from(username, "utf8").toString("base64url");
}

function usersStore() {
  return blobStore("maogai-users");
}

function progressStore() {
  return blobStore("maogai-progress");
}

function questionsStore() {
  return blobStore("maogai-question-cloud");
}

function contentStore() {
  return blobStore("maogai-study-content");
}

function auditStore() {
  return blobStore("maogai-audit");
}

function discussionStore() {
  return blobStore("maogai-discussion");
}

function blobStore(name) {
  const siteID = process.env.NETLIFY_BLOBS_SITE_ID || process.env.SITE_ID;
  const token = process.env.NETLIFY_BLOBS_TOKEN || process.env.NETLIFY_AUTH_TOKEN;
  if (siteID && token) return getStore({ name, siteID, token });
  return getStore(name);
}

function hashPassword(password, salt = randomBytes(16).toString("base64url")) {
  const hash = pbkdf2Sync(password, salt, 120_000, 32, "sha256").toString("base64url");
  return { salt, hash };
}

function verifyPassword(password, user) {
  const current = hashPassword(password, user.salt).hash;
  const a = Buffer.from(current);
  const b = Buffer.from(user.hash || "");
  return a.length === b.length && timingSafeEqual(a, b);
}

function authSecret() {
  return globalThis.Netlify?.env?.get("AUTH_SECRET")
    || process.env.AUTH_SECRET
    || "maogai-local-dev-secret-change-me";
}

function signPayload(payload) {
  return createHmac("sha256", authSecret()).update(payload).digest("base64url");
}

function signToken(username) {
  const now = Math.floor(Date.now() / 1000);
  const payload = Buffer.from(JSON.stringify({
    sub: username,
    iat: now,
    exp: now + TOKEN_DAYS * 24 * 60 * 60
  })).toString("base64url");
  return `${payload}.${signPayload(payload)}`;
}

function verifyToken(event) {
  const headers = event.headers || {};
  const header = headers.authorization || headers.Authorization || "";
  const token = header.replace(/^Bearer\s+/i, "").trim();
  const [payload, signature] = token.split(".");
  if (!payload || !signature || signPayload(payload) !== signature) {
    throw new Error("请先登录");
  }
  const parsed = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  if (!parsed.sub || parsed.exp < Math.floor(Date.now() / 1000)) {
    throw new Error("登录已过期");
  }
  return normalizeUsername(parsed.sub);
}

function adminUsers() {
  return new Set(String(process.env.ADMIN_USERS || "")
    .split(/[,\s;]+/)
    .map(item => item.trim())
    .filter(Boolean));
}

function isAdminUsername(username) {
  return adminUsers().has(username);
}

async function isAdminUser(username) {
  if (isAdminUsername(username)) return true;
  const user = await usersStore().get(userKey(username), { type: "json" });
  return Boolean(user?.isAdmin);
}

async function authContext(event) {
  const username = verifyToken(event);
  return { username, isAdmin: await isAdminUser(username) };
}

async function requireAdmin(event) {
  const auth = await authContext(event);
  if (!auth.isAdmin) throw new Error("需要管理员权限");
  return auth;
}

function plainObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
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

function cleanText(value, limit) {
  return String(value ?? "").trim().slice(0, limit);
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
  if (normalizedOptions.length < 2) throw new Error("至少需要 2 个选项");
  const answer = parseAnswer(q.answer).filter(letter => letter.charCodeAt(0) - 65 < normalizedOptions.length);
  if (!answer.length) throw new Error("请填写正确答案字母");
  if (type === "single" && answer.length !== 1) throw new Error("单选题只能有 1 个正确答案");
  if (type === "judge" && answer.length !== 1) throw new Error("判断题只能有 1 个正确答案");

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
  if (!base.stem) throw new Error("题干不能为空");
  if (!base.analysis) base.analysis = `答案：${answer.join("、")}。`;
  return base;
}

async function getQuestionCloud() {
  const store = questionsStore();
  const current = await store.get("cloud", { type: "json" });
  return current && typeof current === "object" ? {
    version: Number(current.version || 1),
    additions: Array.isArray(current.additions) ? current.additions : [],
    patches: plainObject(current.patches),
    deleted: plainObject(current.deleted),
    banks: plainObject(current.banks)
  } : { version: 1, additions: [], patches: {}, deleted: {}, banks: {} };
}

async function setQuestionCloud(data) {
  const store = questionsStore();
  await store.setJSON("cloud", {
    version: Number(data.version || 1) + 1,
    additions: Array.isArray(data.additions) ? data.additions : [],
    patches: plainObject(data.patches),
    deleted: plainObject(data.deleted),
    banks: plainObject(data.banks),
    updatedAt: new Date().toISOString()
  });
}

function newId(prefix) {
  const stamp = Date.now().toString(36).toUpperCase();
  const rand = Math.random().toString(36).slice(2, 8).toUpperCase();
  return `${prefix}${stamp}${rand}`;
}

async function writeAudit(actor, action, summary, detail = {}) {
  const store = auditStore();
  const item = {
    id: newId("AU"),
    actor,
    action,
    summary: cleanText(summary, 500),
    detail,
    at: new Date().toISOString()
  };
  await store.setJSON(item.id, item);
  return item;
}

async function listAudit(options = 120) {
  const store = auditStore();
  const result = await store.list();
  const sortedKeys = result.blobs.map(blob => blob.key).sort().reverse();
  if (typeof options === "object" && options) {
    const pageSize = Math.max(5, Math.min(80, Number(options.pageSize || 12)));
    const total = sortedKeys.length;
    const totalPages = Math.max(1, Math.ceil(total / pageSize));
    const page = Math.max(1, Math.min(totalPages, Number(options.page || 1)));
    const keys = sortedKeys.slice((page - 1) * pageSize, page * pageSize);
    const rows = [];
    for (const key of keys) {
      const item = await store.get(key, { type: "json" });
      if (item) rows.push(item);
    }
    return { rows, page, pageSize, total, totalPages };
  }
  const limit = Math.max(1, Number(options || 120));
  const keys = sortedKeys.slice(0, limit);
  const rows = [];
  for (const key of keys) {
    const item = await store.get(key, { type: "json" });
    if (item) rows.push(item);
  }
  return rows;
}

async function listUsers() {
  const store = usersStore();
  const result = await store.list();
  const rows = [];
  for (const blob of result.blobs) {
    const user = await store.get(blob.key, { type: "json" });
    if (user?.username) {
      rows.push({
        username: user.username,
        createdAt: user.createdAt || "",
        isAdmin: await isAdminUser(user.username),
        isEnvAdmin: isAdminUsername(user.username)
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

function canManageQuestion(auth, cloud, id, mode = "edit") {
  if (auth.isAdmin) return true;
  const added = findCloudQuestion(cloud, id);
  const bank = bankForQuestion(cloud, added);
  if (mode.includes("delete")) {
    return Boolean(added?.bankId && bank?.createdBy === auth.username);
  }
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

module.exports = {
  bad,
  cleanStore,
  authContext,
  canManageQuestion,
  contentStore,
  discussionStore,
  findCloudQuestion,
  getQuestionCloud,
  hashPassword,
  isAdminUser,
  isAdminUsername,
  json,
  limitedOriginalPatch,
  listAudit,
  listUsers,
  newId,
  normalizeUsername,
  plainObject,
  progressStore,
  readJson,
  requireAdmin,
  sanitizeQuestion,
  setQuestionCloud,
  signToken,
  userKey,
  usersStore,
  validatePassword,
  verifyPassword,
  verifyToken,
  writeAudit
};
