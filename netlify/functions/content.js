const {
  authContext,
  bad,
  contentStore,
  json,
  newId,
  plainObject,
  readJson,
  writeAudit
} = require("../lib/api");

function cleanText(value, limit) {
  return String(value ?? "").trim().slice(0, limit);
}

function cleanOrder(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : undefined;
}

function emptyContentCloud() {
  return {
    version: 1,
    timeline: { additions: [], patches: {}, deleted: {} },
    keypoints: { additions: [], patches: {}, deleted: {} }
  };
}

function normalizeBucket(bucket = {}) {
  return {
    additions: Array.isArray(bucket.additions) ? bucket.additions : [],
    patches: plainObject(bucket.patches),
    deleted: plainObject(bucket.deleted)
  };
}

async function getContentCloud() {
  const current = await contentStore().get("cloud", { type: "json" });
  if (!current || typeof current !== "object") return emptyContentCloud();
  return {
    version: Number(current.version || 1),
    timeline: normalizeBucket(current.timeline),
    keypoints: normalizeBucket(current.keypoints)
  };
}

async function setContentCloud(data) {
  await contentStore().setJSON("cloud", {
    version: Number(data.version || 1) + 1,
    timeline: normalizeBucket(data.timeline),
    keypoints: normalizeBucket(data.keypoints),
    updatedAt: new Date().toISOString()
  });
}

function publicCloud(cloud) {
  const compressDeleted = bucket => ({
    additions: bucket.additions,
    patches: bucket.patches,
    deleted: Object.fromEntries(Object.keys(bucket.deleted || {}).map(id => [id, true]))
  });
  return {
    ok: true,
    version: cloud.version,
    timeline: compressDeleted(cloud.timeline),
    keypoints: compressDeleted(cloud.keypoints)
  };
}

function bucketName(type) {
  if (type === "timeline") return "timeline";
  if (type === "keypoint" || type === "keypoints") return "keypoints";
  throw new Error("内容类型不支持");
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
  if (!cleaned.time || !cleaned.name || !cleaned.significance) {
    throw new Error("时间线条目需填写时间、名称和作用");
  }
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
  if (!cleaned.chapter || !cleaned.keyword || !cleaned.content) {
    throw new Error("重点条目需填写章节、关键词和内容");
  }
  return cleaned;
}

function sanitize(type, item) {
  return bucketName(type) === "timeline" ? sanitizeTimeline(item) : sanitizeKeypoint(item);
}

function findAddition(bucket, id) {
  return bucket.additions.find(item => item.id === id) || null;
}

exports.handler = async event => {
  try {
    if (event.httpMethod === "GET") {
      return json(publicCloud(await getContentCloud()));
    }

    const auth = await authContext(event);
    const body = readJson(event);
    const cloud = await getContentCloud();
    const name = bucketName(body.type);
    const bucket = cloud[name];

    if (event.httpMethod === "POST") {
      const item = {
        ...sanitize(body.type, body.item || body),
        id: newId(name === "timeline" ? "TLU" : "KPU"),
        createdBy: auth.username,
        createdAt: new Date().toISOString()
      };
      bucket.additions.push(item);
      await setContentCloud(cloud);
      await writeAudit(auth.username, `content:${name}:add`, `新增${name === "timeline" ? "时间线" : "重点"}：${item.name || item.keyword}`, { item });
      return json({ ok: true, item });
    }

    if (event.httpMethod === "PUT") {
      const id = cleanText(body.id, 80);
      if (!id) return bad("内容 ID 不能为空", 400);
      const patch = {
        ...sanitize(body.type, body.patch || body.item || body),
        updatedBy: auth.username,
        updatedAt: new Date().toISOString()
      };
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
      await setContentCloud(cloud);
      await writeAudit(auth.username, `content:${name}:update`, `修改${name === "timeline" ? "时间线" : "重点"}：${id}`, { id, before, after });
      return json({ ok: true, id, patch: after });
    }

    if (event.httpMethod === "DELETE") {
      const id = cleanText(body.id || event.queryStringParameters?.id, 80);
      if (!id) return bad("内容 ID 不能为空", 400);
      bucket.deleted[id] = {
        id,
        deletedBy: auth.username,
        deletedAt: new Date().toISOString()
      };
      await setContentCloud(cloud);
      await writeAudit(auth.username, `content:${name}:delete`, `删除${name === "timeline" ? "时间线" : "重点"}：${id}`, { id });
      return json({ ok: true, id });
    }

    return bad("方法不支持", 405);
  } catch (error) {
    const status = ["请先登录", "登录已过期"].includes(error.message) ? 401 : 400;
    return bad(error.message || "内容接口异常", status);
  }
};
