const {
  bad,
  cleanStore,
  json,
  progressStore,
  readJson,
  userKey,
  verifyToken
} = require("../lib/api");

exports.handler = async event => {
  try {
    const username = verifyToken(event);
    const store = progressStore();
    const key = userKey(username);

    if (event.httpMethod === "GET") {
      const progress = await store.get(key, { type: "json" });
      return json({ ok: true, store: cleanStore(progress?.store || progress || {}) });
    }

    if (event.httpMethod === "PUT") {
      const body = readJson(event);
      const cleaned = cleanStore(body.store || body);
      await store.setJSON(key, {
        store: cleaned,
        updatedAt: new Date().toISOString()
      });
      return json({ ok: true, store: cleaned });
    }

    return bad("方法不支持", 405);
  } catch (error) {
    return bad(error.message || "进度接口异常", error.message === "请先登录" ? 401 : 400);
  }
};
