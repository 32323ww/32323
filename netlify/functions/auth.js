const {
  bad,
  hashPassword,
  json,
  authContext,
  isAdminUser,
  normalizeUsername,
  readJson,
  signToken,
  userKey,
  usersStore,
  validatePassword,
  verifyPassword
} = require("../lib/api");

exports.handler = async event => {
  if (event.httpMethod === "GET") {
    try {
      const auth = await authContext(event);
      return json({ ok: true, user: { username: auth.username, isAdmin: auth.isAdmin } });
    } catch (error) {
      return bad(error.message || "请先登录", 401);
    }
  }

  if (event.httpMethod !== "POST") return bad("方法不支持", 405);
  try {
    const body = readJson(event);
    const action = String(body.action || "").trim();
    const username = normalizeUsername(body.username);
    const password = validatePassword(body.password);
    const store = usersStore();
    const key = userKey(username);
    const existing = await store.get(key, { type: "json" });

    if (action === "register") {
      if (existing) return bad("账号已存在", 409);
      const hashed = hashPassword(password);
      await store.setJSON(key, {
        username,
        salt: hashed.salt,
        hash: hashed.hash,
        createdAt: new Date().toISOString()
      });
      return json({ ok: true, user: { username, isAdmin: await isAdminUser(username) }, token: signToken(username) });
    }

    if (action === "login") {
      if (!existing || !verifyPassword(password, existing)) return bad("账号或密码不正确", 401);
      const storedName = existing.username || username;
      return json({ ok: true, user: { username: storedName, isAdmin: await isAdminUser(storedName) }, token: signToken(storedName) });
    }

    return bad("未知操作", 400);
  } catch (error) {
    return bad(error.message || "账号接口异常", 400);
  }
};
