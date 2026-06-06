const {
  bad,
  getQuestionCloud,
  json,
  newId,
  plainObject,
  readJson,
  requireAdmin,
  setQuestionCloud,
  writeAudit
} = require("../lib/api");

const ARK_BASE_URL = "https://ark.cn-beijing.volces.com/api/v3";
const DEFAULT_MODEL = "doubao-seed-2-0-pro-260215";
const LETTERS = ["A", "B", "C", "D", "E"];
const MAX_BATCH = 2;
const ARK_TIMEOUT_MS = 24_000;

function cleanText(value, limit) {
  return String(value ?? "").trim().slice(0, limit);
}

function normalizeAnswer(value, optionCount = 5) {
  const raw = Array.isArray(value) ? value.join("") : String(value || "");
  return [...new Set((raw.toUpperCase().match(/[A-E]/g) || [])
    .filter(letter => letter.charCodeAt(0) - 65 < optionCount))]
    .sort((a, b) => LETTERS.indexOf(a) - LETTERS.indexOf(b));
}

function answerText(answer) {
  return normalizeAnswer(answer).join("");
}

function questionTypeLabel(type) {
  if (type === "single") return "单选题";
  if (type === "multi") return "多选题";
  if (type === "judge") return "判断题";
  return "选择题";
}

function buildPrompt(question) {
  const options = (question.options || [])
    .map((option, index) => `${LETTERS[index]}. ${option}`)
    .join("\n");
  return `你是《毛泽东思想和中国特色社会主义理论体系概论》考试选择题解析助手。
请依据可靠教材、权威资料和通行考试知识点作答。

题型：${questionTypeLabel(question.type)}
题干：${question.stem}
选项：
${options}

要求：
1. 只输出 JSON，不要输出 Markdown。
2. 不要说“题目没有给出答案”，请独立判断正确答案。
3. 单选题只给一个字母，多选题可给多个字母，判断题按选项字母作答。
4. 解析要面向单选/多选/判断考试，重点写清考点、为什么选、错误选项在什么条件下可能正确、易混点。
5. optionAnalysis 必须逐项给出实际存在选项的辨析。

JSON 格式：
{
  "answer": ["A"],
  "analysis": "总解析，200-500字",
  "optionAnalysis": {
    "A": "A项辨析",
    "B": "B项辨析"
  },
  "confidence": "high|medium|low",
  "uncertainty": "如题干或选项有歧义，在这里说明；没有则写空字符串"
}`;
}

function extractResponseText(data) {
  if (data.output_text) return String(data.output_text);
  const chunks = [];
  for (const item of data.output || []) {
    for (const content of item.content || []) {
      if ((content.type === "output_text" || content.type === "text") && content.text) {
        chunks.push(content.text);
      }
    }
  }
  return chunks.join("\n");
}

function extractJson(text) {
  const cleaned = String(text || "")
    .trim()
    .replace(/^```(?:json)?/i, "")
    .replace(/```$/i, "")
    .trim();
  try {
    return JSON.parse(cleaned);
  } catch {
    const match = cleaned.match(/\{[\s\S]*\}/);
    if (!match) throw new Error("豆包未返回可解析 JSON");
    return JSON.parse(match[0]);
  }
}

async function callArk(question, model, useWeb) {
  const apiKey = process.env.ARK_API_KEY;
  if (!apiKey) throw new Error("线上未设置 ARK_API_KEY");
  const body = {
    model,
    temperature: 0.2,
    max_output_tokens: 1800,
    input: [{
      role: "user",
      content: [{ type: "input_text", text: buildPrompt(question) }]
    }]
  };
  if (useWeb) body.tools = [{ type: "web_search" }];
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ARK_TIMEOUT_MS);
  let response;
  try {
    response = await fetch(`${ARK_BASE_URL}/responses`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${apiKey}`,
        "content-type": "application/json"
      },
      body: JSON.stringify(body),
      signal: controller.signal
    });
  } catch (error) {
    const cause = error.cause ? ` (${error.cause.code || ""} ${error.cause.message || error.cause})` : "";
    const message = error.name === "AbortError"
      ? `豆包接口超时：${Math.round(ARK_TIMEOUT_MS / 1000)}s`
      : `豆包接口网络失败：${error.message || "fetch failed"}${cause}`;
    throw new Error(message);
  } finally {
    clearTimeout(timer);
  }
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(data.error?.message || data.message || `豆包接口失败：${response.status}`);
  }
  return extractJson(extractResponseText(data));
}

async function reviewQuestion(question, model, useWeb) {
  return callArk(question, model, useWeb);
}

function patchFromAi(question, ai, model) {
  const originalAnswer = normalizeAnswer(question.answer, question.options.length);
  const aiAnswer = normalizeAnswer(ai.answer, question.options.length);
  const disputed = Boolean(aiAnswer.length && aiAnswer.join("") !== originalAnswer.join(""));
  const optionAnalysis = {};
  const rawOptionAnalysis = plainObject(ai.optionAnalysis);
  for (let i = 0; i < question.options.length; i += 1) {
    const letter = LETTERS[i];
    const text = cleanText(rawOptionAnalysis[letter], 900);
    if (text) optionAnalysis[letter] = text;
  }
  const uncertainty = cleanText(ai.uncertainty, 300);
  let disputeNote = "";
  if (disputed) {
    disputeNote = `AI 判断答案为 ${aiAnswer.join("")}，网站原答案为 ${originalAnswer.join("")}，原答案已保留，需人工复核。`;
  }
  if (uncertainty) disputeNote = `${disputeNote} ${uncertainty}`.trim();
  const patch = {
    analysis: cleanText(ai.analysis, 2400) || question.analysis || `答案：${originalAnswer.join("、")}。`,
    optionAnalysis,
    aiAnswer,
    aiModel: model,
    aiCheckedAt: new Date().toISOString(),
    aiConfidence: cleanText(ai.confidence, 20),
    disputed,
    updatedAt: new Date().toISOString()
  };
  if (disputeNote) patch.disputeNote = disputeNote;
  else patch.disputeNote = "";
  return patch;
}

function sanitizeIncomingQuestion(raw) {
  const options = (Array.isArray(raw.options) ? raw.options : [])
    .map(option => cleanText(option, 220))
    .filter(Boolean)
    .slice(0, 5);
  if (!raw.id || !raw.stem || options.length < 2) throw new Error("题目数据不完整");
  return {
    id: cleanText(raw.id, 80),
    type: ["single", "multi", "judge"].includes(raw.type) ? raw.type : "single",
    stem: cleanText(raw.stem, 900),
    options,
    answer: normalizeAnswer(raw.answer, options.length),
    analysis: cleanText(raw.analysis, 2400)
  };
}

function sanitizeUploadedAiPatch(raw) {
  const item = plainObject(raw);
  const id = cleanText(item.id || item.questionId, 80);
  if (!id) throw new Error("题目 ID 不能为空");
  const patchInput = plainObject(item.patch || item);
  const optionCount = Math.max(2, Math.min(5, Number(item.optionCount || patchInput.optionCount || 5)));
  const optionAnalysis = {};
  const rawOptionAnalysis = plainObject(patchInput.optionAnalysis);
  for (let i = 0; i < optionCount; i += 1) {
    const letter = LETTERS[i];
    const text = cleanText(rawOptionAnalysis[letter], 900);
    if (text) optionAnalysis[letter] = text;
  }
  const aiAnswer = normalizeAnswer(patchInput.aiAnswer || patchInput.answer, optionCount);
  const patch = {
    analysis: cleanText(patchInput.analysis, 2400),
    optionAnalysis,
    aiAnswer,
    aiModel: cleanText(patchInput.aiModel || patchInput.model, 120),
    aiCheckedAt: cleanText(patchInput.aiCheckedAt, 80) || new Date().toISOString(),
    aiConfidence: cleanText(patchInput.aiConfidence || patchInput.confidence, 20),
    disputed: Boolean(patchInput.disputed),
    disputeNote: cleanText(patchInput.disputeNote, 600),
    updatedAt: new Date().toISOString()
  };
  if (!patch.analysis && !Object.keys(optionAnalysis).length) throw new Error("解析内容不能为空");
  return { id, patch };
}

exports.handler = async event => {
  try {
    const auth = await requireAdmin(event);
    if (event.httpMethod !== "POST") return bad("方法不支持", 405);
    const body = readJson(event);
    if (body.action === "upload") {
      const uploads = Array.isArray(body.patches) ? body.patches.slice(0, 100) : [];
      if (!uploads.length) return bad("没有可上传的 AI 解析", 400);
      const cloud = await getQuestionCloud();
      const results = [];
      let success = 0;
      let disputed = 0;
      for (const rawPatch of uploads) {
        try {
          const { id, patch } = sanitizeUploadedAiPatch(rawPatch);
          cloud.patches[id] = {
            ...plainObject(cloud.patches[id]),
            ...patch,
            updatedBy: auth.username
          };
          success += 1;
          if (patch.disputed) disputed += 1;
          results.push({ id, ok: true, disputed: patch.disputed, aiAnswer: patch.aiAnswer });
        } catch (error) {
          results.push({ id: cleanText(rawPatch?.id, 80), ok: false, message: error.message || "AI 解析上传失败" });
        }
      }
      if (success) await setQuestionCloud(cloud);
      await writeAudit(auth.username, "ai-review:upload", `本地上传 AI 解析：成功 ${success} 道，争议 ${disputed} 道`, {
        id: newId("AIR"),
        success,
        disputed,
        results
      });
      return json({ ok: true, success, disputed, results });
    }
    const model = cleanText(body.model || DEFAULT_MODEL, 120);
    const useWeb = Boolean(body.useWeb);
    const incoming = Array.isArray(body.questions) ? body.questions.slice(0, MAX_BATCH) : [];
    if (!incoming.length) return bad("没有可处理题目", 400);

    const questions = incoming.map(sanitizeIncomingQuestion);
    const cloud = await getQuestionCloud();
    const results = [];
    let success = 0;
    let disputed = 0;

    for (const question of questions) {
      try {
        const ai = await reviewQuestion(question, model, useWeb);
        const patch = patchFromAi(question, ai, model);
        cloud.patches[question.id] = {
          ...plainObject(cloud.patches[question.id]),
          ...patch,
          updatedBy: auth.username
        };
        success += 1;
        if (patch.disputed) disputed += 1;
        results.push({
          id: question.id,
          ok: true,
          disputed: patch.disputed,
          aiAnswer: patch.aiAnswer,
          originalAnswer: question.answer
        });
      } catch (error) {
        results.push({ id: question.id, ok: false, message: error.message || "AI 复核失败" });
      }
    }

    if (success) await setQuestionCloud(cloud);
    await writeAudit(auth.username, "ai-review:batch", `AI 更新解析：成功 ${success} 道，争议 ${disputed} 道`, {
      id: newId("AIR"),
      success,
      disputed,
      results
    });
    return json({ ok: true, success, disputed, results });
  } catch (error) {
    return bad(error.message || "AI 解析接口异常", error.message === "需要管理员权限" ? 403 : 400);
  }
};
