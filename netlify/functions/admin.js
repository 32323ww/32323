const {
  bad,
  hashPassword,
  isAdminUser,
  isAdminUsername,
  json,
  listAudit,
  listUsers,
  normalizeUsername,
  progressStore,
  readJson,
  requireAdmin,
  userKey,
  usersStore,
  validatePassword,
  writeAudit
} = require("../lib/api");

exports.handler = async event => {
  try {
    const auth = await requireAdmin(event);

    if (event.httpMethod === "GET") {
      const action = String(event.queryStringParameters?.action || "summary");
      const auditPage = Number(event.queryStringParameters?.auditPage || event.queryStringParameters?.page || 1);
      const auditPageSize = Number(event.queryStringParameters?.auditPageSize || event.queryStringParameters?.pageSize || 12);
      const auditResult = async () => listAudit({ page: auditPage, pageSize: auditPageSize });
      if (action === "users") return json({ ok: true, users: await listUsers() });
      if (action === "audit") {
        const pageData = await auditResult();
        return json({ ok: true, audit: pageData.rows, auditPage: pageData.page, auditPageSize: pageData.pageSize, auditTotal: pageData.total, auditTotalPages: pageData.totalPages });
      }
      const pageData = await auditResult();
      return json({ ok: true, users: await listUsers(), audit: pageData.rows, auditPage: pageData.page, auditPageSize: pageData.pageSize, auditTotal: pageData.total, auditTotalPages: pageData.totalPages });
    }

    if (event.httpMethod === "POST") {
      const body = readJson(event);
      const action = String(body.action || "").trim();
      const store = usersStore();

      if (action === "createUser") {
        const username = normalizeUsername(body.username);
        const password = validatePassword(body.password);
        const key = userKey(username);
        if (await store.get(key, { type: "json" })) return bad("账号已存在", 409);
        const hashed = hashPassword(password);
        const user = {
          username,
          salt: hashed.salt,
          hash: hashed.hash,
          createdAt: new Date().toISOString(),
          createdBy: auth.username
        };
        await store.setJSON(key, user);
        await writeAudit(auth.username, "account:create", `创建账号：${username}`, { username });
        return json({ ok: true, user: { username, createdAt: user.createdAt, isAdmin: await isAdminUser(username), isEnvAdmin: isAdminUsername(username) } });
      }

      if (action === "setAdmin") {
        const username = normalizeUsername(body.username);
        const enabled = Boolean(body.isAdmin);
        if (username === auth.username && !enabled) return bad("不能取消当前登录账号的管理员权限", 400);
        if (isAdminUsername(username) && !enabled) return bad("不能取消环境变量保留管理员权限", 400);
        const key = userKey(username);
        const user = await store.get(key, { type: "json" });
        if (!user) return bad("账号不存在", 404);
        const before = { username, isAdmin: await isAdminUser(username), isEnvAdmin: isAdminUsername(username) };
        user.isAdmin = enabled;
        user.adminUpdatedAt = new Date().toISOString();
        user.adminUpdatedBy = auth.username;
        await store.setJSON(key, user);
        const after = { username, createdAt: user.createdAt, isAdmin: await isAdminUser(username), isEnvAdmin: isAdminUsername(username) };
        await writeAudit(auth.username, enabled ? "account:admin-grant" : "account:admin-revoke", `${enabled ? "设为" : "取消"}管理员：${username}`, { before, after });
        return json({ ok: true, user: after });
      }

      if (action === "deleteUser") {
        const username = normalizeUsername(body.username);
        if (username === auth.username) return bad("不能删除当前登录的管理员账号", 400);
        if (await isAdminUser(username)) return bad("请先取消该账号的管理员权限，再删除账号", 400);
        await store.delete(userKey(username));
        await progressStore().delete(userKey(username));
        await writeAudit(auth.username, "account:delete", `删除账号：${username}`, { username });
        return json({ ok: true });
      }

      return bad("未知操作", 400);
    }

    return bad("方法不支持", 405);
  } catch (error) {
    return bad(error.message || "管理员接口异常", error.message === "需要管理员权限" ? 403 : 400);
  }
};
