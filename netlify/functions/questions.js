const {
  bad,
  authContext,
  canManageQuestion,
  findCloudQuestion,
  getQuestionCloud,
  json,
  limitedOriginalPatch,
  newId,
  plainObject,
  readJson,
  sanitizeQuestion,
  setQuestionCloud,
  writeAudit
} = require("../lib/api");

function canManageBank(auth, bank) {
  return auth.isAdmin || bank?.createdBy === auth.username;
}

function cloudPublic(cloud) {
  const deleted = Object.fromEntries(Object.keys(cloud.deleted || {}).map(id => [id, true]));
  return {
    ok: true,
    version: cloud.version,
    additions: cloud.additions,
    patches: cloud.patches,
    deleted,
    banks: cloud.banks
  };
}

function cleanBankName(value) {
  const name = String(value || "").trim().slice(0, 40);
  if (!name) throw new Error("题库名称不能为空");
  return name;
}

function duplicateKey(question) {
  const compact = value => String(value || "")
    .toLowerCase()
    .replace(/[【】（）()《》“”"'\s，,。.:：；;、？?！!]/g, "");
  return [
    question.type,
    compact(question.stem),
    (question.options || []).map(compact).join("|")
  ].join("::");
}

function existingQuestionKeys(cloud) {
  const keys = new Set();
  for (const item of cloud.additions || []) {
    if (!cloud.deleted?.[item.id]) keys.add(duplicateKey(item));
  }
  return keys;
}

function prepareQuestionForAdd(auth, cloud, raw) {
  const question = sanitizeQuestion(raw, "add");
  if (question.bankId) {
    const bank = cloud.banks[question.bankId];
    if (!canManageBank(auth, bank)) throw new Error("只能向自己的题库添加题目");
    question.bankName = bank.name;
    question.source = String(question.source || "").startsWith("用户新增题库：") ? question.source : `用户题库：${bank.name}`;
  }
  return question;
}

exports.handler = async event => {
  try {
    if (event.httpMethod === "GET") {
      const cloud = await getQuestionCloud();
      return json(cloudPublic(cloud));
    }

    const auth = await authContext(event);
    const body = readJson(event);
    const cloud = await getQuestionCloud();

    if (event.httpMethod === "POST") {
      if (body.action === "createBank") {
        const bank = {
          id: newId("BK"),
          name: cleanBankName(body.name),
          createdBy: auth.username,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString()
        };
        cloud.banks[bank.id] = bank;
        await setQuestionCloud(cloud);
        await writeAudit(auth.username, "bank:create", `创建题库：${bank.name}`, { bank });
        return json({ ok: true, bank });
      }

      if (body.action === "bulkImport") {
        const rawQuestions = Array.isArray(body.questions) ? body.questions : [];
        if (!rawQuestions.length) return bad("没有可导入的题目", 400);
        const keys = existingQuestionKeys(cloud);
        const imported = [];
        const skipped = [];
        for (const raw of rawQuestions.slice(0, 200)) {
          const question = prepareQuestionForAdd(auth, cloud, raw);
          const key = duplicateKey(question);
          if (keys.has(key)) {
            skipped.push({ stem: question.stem, reason: "重复题目" });
            continue;
          }
          keys.add(key);
          const item = {
            ...question,
            id: newId("UQ"),
            createdBy: auth.username,
            createdAt: new Date().toISOString()
          };
          cloud.additions.push(item);
          imported.push(item);
        }
        if (imported.length) await setQuestionCloud(cloud);
        await writeAudit(auth.username, "question:bulk-import", `批量导入题目：${imported.length} 道，跳过 ${skipped.length} 道`, { importedCount: imported.length, skipped });
        return json({ ok: true, imported, skipped });
      }

      const question = prepareQuestionForAdd(auth, cloud, body.question || body);
      if (existingQuestionKeys(cloud).has(duplicateKey(question))) return bad("题库中已存在相同题目", 409);
      const item = {
        ...question,
        id: newId("UQ"),
        createdBy: auth.username,
        createdAt: new Date().toISOString()
      };
      cloud.additions.push(item);
      await setQuestionCloud(cloud);
      await writeAudit(auth.username, "question:add", `新增题目：${item.stem.slice(0, 80)}`, { after: item });
      return json({ ok: true, question: item });
    }

    if (event.httpMethod === "PUT") {
      if (body.action === "updateBank") {
        const bank = cloud.banks[String(body.bankId || "")];
        if (!bank) return bad("题库不存在", 404);
        if (!canManageBank(auth, bank)) return bad("无权修改该题库", 403);
        const before = { ...bank };
        bank.name = cleanBankName(body.name);
        bank.updatedAt = new Date().toISOString();
        bank.updatedBy = auth.username;
        cloud.banks[bank.id] = bank;
        cloud.additions = cloud.additions.map(item => item.bankId === bank.id ? {
          ...item,
          bankName: bank.name,
          source: `用户题库：${bank.name}`
        } : item);
        await setQuestionCloud(cloud);
        await writeAudit(auth.username, "bank:update", `修改题库：${bank.name}`, { before, after: bank });
        return json({ ok: true, bank });
      }

      const id = String(body.id || "").trim();
      if (!id) return bad("题目 ID 不能为空", 400);
      const existingAddition = findCloudQuestion(cloud, id);
      const fullPatch = sanitizeQuestion(body.patch || body.question || body, "edit");
      const allowed = canManageQuestion(auth, cloud, id, existingAddition ? "cloud-edit" : "limited-original-edit");
      if (!allowed) return bad("无权修改该题", 403);
      let patch = fullPatch;
      if (!auth.isAdmin && !existingAddition) patch = limitedOriginalPatch(fullPatch);
      if (patch.bankId) {
        const bank = cloud.banks[patch.bankId];
        if (!canManageBank(auth, bank)) return bad("无权把题目移动到该题库", 403);
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
        cloud.patches[id] = {
          ...plainObject(cloud.patches[id]),
          ...patch,
          updatedBy: auth.username,
          updatedAt: new Date().toISOString()
        };
        after = cloud.patches[id];
      }
      delete cloud.deleted[id];
      await setQuestionCloud(cloud);
      await writeAudit(auth.username, "question:update", `修改题目：${id}`, { id, before, after });
      return json({ ok: true, id, patch: after });
    }

    if (event.httpMethod === "DELETE") {
      if (body.action === "deleteBank") {
        const bank = cloud.banks[String(body.bankId || "")];
        if (!bank) return bad("题库不存在", 404);
        if (!canManageBank(auth, bank)) return bad("无权删除该题库", 403);
        const deletedAt = new Date().toISOString();
        const before = { ...bank };
        const deletedQuestions = [];
        for (const item of cloud.additions || []) {
          if (item.bankId === bank.id) {
            cloud.deleted[item.id] = {
              id: item.id,
              deletedBy: auth.username,
              deletedAt,
              reason: `删除题库：${bank.name}`
            };
            deletedQuestions.push(item.id);
          }
        }
        for (const [questionId, patch] of Object.entries(cloud.patches || {})) {
          if (patch?.bankId === bank.id) {
            cloud.patches[questionId] = {
              ...patch,
              bankId: "",
              bankName: "",
              updatedBy: auth.username,
              updatedAt: deletedAt
            };
          }
        }
        delete cloud.banks[bank.id];
        await setQuestionCloud(cloud);
        await writeAudit(auth.username, "bank:delete", `删除题库：${before.name}`, { before, deletedQuestions });
        return json({ ok: true, bankId: before.id, deletedQuestions });
      }

      const id = String(body.id || event.queryStringParameters?.id || "").trim();
      if (!id) return bad("题目 ID 不能为空", 400);
      const existingAddition = findCloudQuestion(cloud, id);
      if (!canManageQuestion(auth, cloud, id, existingAddition ? "cloud-delete" : "delete")) return bad("无权删除该题", 403);
      const before = existingAddition || plainObject(cloud.patches[id]);
      cloud.deleted[id] = {
        id,
        deletedBy: auth.username,
        deletedAt: new Date().toISOString(),
        reason: String(body.reason || "").slice(0, 200)
      };
      await setQuestionCloud(cloud);
      await writeAudit(auth.username, "question:delete", `删除题目：${id}`, { id, before, deleted: cloud.deleted[id] });
      return json({ ok: true, id });
    }

    return bad("方法不支持", 405);
  } catch (error) {
    return bad(error.message || "题目接口异常", error.message === "请先登录" ? 401 : 400);
  }
};
