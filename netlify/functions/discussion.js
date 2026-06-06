const {
  authContext,
  bad,
  discussionStore,
  json,
  newId,
  readJson,
  writeAudit
} = require("../lib/api");

function cleanMessage(value) {
  const text = String(value || "").trim().slice(0, 1000);
  if (!text) throw new Error("发言内容不能为空");
  return text;
}

async function listPosts(limit = 120) {
  const store = discussionStore();
  const result = await store.list();
  const keys = result.blobs.map(blob => blob.key).sort().reverse();
  const posts = [];
  for (const key of keys) {
    const item = await store.get(key, { type: "json" });
    if (item && !item.deletedAt) posts.push(item);
  }
  return posts
    .sort((a, b) => {
      if (Boolean(a.pinned) !== Boolean(b.pinned)) return a.pinned ? -1 : 1;
      return Date.parse(b.pinnedAt || b.createdAt || "") - Date.parse(a.pinnedAt || a.createdAt || "");
    })
    .slice(0, limit);
}

exports.handler = async event => {
  try {
    if (event.httpMethod === "GET") {
      return json({ ok: true, posts: await listPosts(Number(event.queryStringParameters?.limit || 120)) });
    }

    if (event.httpMethod === "POST") {
      const auth = await authContext(event);
      const body = readJson(event);
      if (body.action === "pin") {
        if (!auth.isAdmin) return bad("只有管理员可以置顶帖子", 403);
        const postId = String(body.id || body.postId || "").trim();
        if (!postId) return bad("帖子 ID 不能为空", 400);
        const store = discussionStore();
        const post = await store.get(postId, { type: "json" });
        if (!post || post.deletedAt) return bad("帖子不存在", 404);
        const before = { pinned: Boolean(post.pinned), pinnedAt: post.pinnedAt || "" };
        post.pinned = Boolean(body.pinned);
        post.pinnedAt = post.pinned ? new Date().toISOString() : "";
        post.pinnedBy = post.pinned ? auth.username : "";
        await store.setJSON(postId, post);
        await writeAudit(auth.username, post.pinned ? "discussion:pin" : "discussion:unpin", `${post.pinned ? "置顶" : "取消置顶"}帖子：${postId}`, { postId, before, after: { pinned: post.pinned, pinnedAt: post.pinnedAt } });
        return json({ ok: true, post });
      }
      if (body.action === "reply") {
        const postId = String(body.postId || "").trim();
        if (!postId) return bad("帖子 ID 不能为空", 400);
        const store = discussionStore();
        const post = await store.get(postId, { type: "json" });
        if (!post || post.deletedAt) return bad("帖子不存在", 404);
        const reply = {
          id: newId("RP"),
          author: auth.username,
          message: cleanMessage(body.message),
          createdAt: new Date().toISOString()
        };
        post.replies = Array.isArray(post.replies) ? post.replies : [];
        post.replies.push(reply);
        await store.setJSON(postId, post);
        await writeAudit(auth.username, "discussion:reply", `回复帖子：${postId}`, { postId, reply });
        return json({ ok: true, reply });
      }

      const post = {
        id: newId("DS"),
        author: auth.username,
        message: cleanMessage(body.message),
        createdAt: new Date().toISOString(),
        replies: []
      };
      await discussionStore().setJSON(post.id, post);
      await writeAudit(auth.username, "discussion:add", `讨论区发言：${post.message.slice(0, 80)}`, { post });
      return json({ ok: true, post });
    }

    if (event.httpMethod === "DELETE") {
      const auth = await authContext(event);
      const body = readJson(event);
      const id = String(body.id || event.queryStringParameters?.id || "").trim();
      if (!id) return bad("发言 ID 不能为空", 400);
      const store = discussionStore();
      const before = await store.get(id, { type: "json" });
      if (!before) return bad("发言不存在", 404);
      const replyId = String(body.replyId || event.queryStringParameters?.replyId || "").trim();
      if (replyId) {
        const replies = Array.isArray(before.replies) ? before.replies : [];
        const index = replies.findIndex(reply => reply.id === replyId);
        if (index < 0) return bad("回复不存在", 404);
        if (!auth.isAdmin && replies[index].author !== auth.username) return bad("只能删除自己发表的回复", 403);
        const deletedReply = { ...replies[index], deletedAt: new Date().toISOString(), deletedBy: auth.username };
        replies[index] = deletedReply;
        const after = { ...before, replies };
        await store.setJSON(id, after);
        await writeAudit(auth.username, "discussion:reply-delete", `删除回复：${replyId}`, { postId: id, deletedReply });
        return json({ ok: true });
      }
      if (!auth.isAdmin && before.author !== auth.username) return bad("只能删除自己发表的帖子", 403);
      const deleted = { ...before, deletedAt: new Date().toISOString(), deletedBy: auth.username };
      await store.setJSON(id, deleted);
      await writeAudit(auth.username, "discussion:delete", `删除讨论区发言：${id}`, { before, deleted });
      return json({ ok: true });
    }

    return bad("方法不支持", 405);
  } catch (error) {
    const status = ["请先登录", "登录已过期"].includes(error.message) ? 401 : (error.message === "需要管理员权限" ? 403 : 400);
    return bad(error.message || "讨论区接口异常", status);
  }
};
