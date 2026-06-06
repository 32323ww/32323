const BASE_BANK = window.MAOGAI_QUESTION_BANK || [];
const BASE_TIMELINE = window.MAOGAI_TIMELINE || [];
const BASE_KEYPOINTS = window.MAOGAI_KEYPOINTS || [];
let BANK = [...BASE_BANK];
let TIMELINE_DATA = [...BASE_TIMELINE];
let KEYPOINTS_DATA = [...BASE_KEYPOINTS];

const STORE_KEY = "maogai_quiz_state_v1";
const AUTH_KEY = "maogai_auth_v1";
const API = {
  auth: "/api/auth",
  progress: "/api/progress",
  questions: "/api/questions",
  aiReview: "/api/ai-review",
  admin: "/api/admin",
  discussion: "/api/discussion",
  content: "/api/content"
};

const TYPE_LABEL = {
  single: "单选",
  multi: "多选",
  judge: "判断"
};

const TYPE_CLASS = {
  single: "",
  multi: "multi",
  judge: "judge"
};

const SOURCE_ORDER = ["机房原题", "学长回忆重点", "其它题库"];
const QUESTION_ID_COLLATOR = new Intl.Collator("zh-Hans-CN", { numeric: true, sensitivity: "base" });
const BROWSE_PAGE_SIZE = 30;
const COLLECTION_PAGE_SIZE = 10;
const ADMIN_USERS_PAGE_SIZE = 8;
const ADMIN_AUDIT_PAGE_SIZE = 12;

const state = {
  view: "practice",
  current: null,
  practiceHistory: [],
  practiceHistoryIndex: -1,
  exam: [],
  examSubmitted: false,
  wrongOnly: false,
  store: loadStore(),
  user: loadAuth(),
  cloud: { version: 0, additions: [], patches: {}, deleted: {}, banks: {} },
  contentCloud: { version: 0, timeline: { additions: [], patches: {}, deleted: {} }, keypoints: { additions: [], patches: {}, deleted: {} } },
  adminData: { users: [], audit: [], auditPage: 1, auditPageSize: ADMIN_AUDIT_PAGE_SIZE, auditTotal: 0, auditTotalPages: 1 },
  discussion: [],
  collapsedReplies: {},
  browsePage: 1,
  wrongPage: 1,
  studiedPage: 1,
  favoritesPage: 1,
  adminUsersPage: 1,
  adminAuditPage: 1,
  syncing: false
};

let cloudSaveTimer = null;

function loadStore() {
  try {
    const stored = JSON.parse(localStorage.getItem(STORE_KEY)) || {};
    return normalizeStore(stored);
  } catch {
    return emptyStore();
  }
}

function saveStore(opts = {}) {
  localStorage.setItem(STORE_KEY, JSON.stringify(state.store));
  if (opts.sync !== false) queueCloudSave();
}

function loadAuth() {
  try {
    const auth = JSON.parse(localStorage.getItem(AUTH_KEY)) || null;
    return auth?.token && auth?.username ? auth : null;
  } catch {
    return null;
  }
}

function saveAuth(auth) {
  if (auth) localStorage.setItem(AUTH_KEY, JSON.stringify(auth));
  else localStorage.removeItem(AUTH_KEY);
}

function emptyStore() {
  return { attempts: {}, wrong: {}, mastered: {}, seen: {}, favorites: {} };
}

function normalizeStore(store = {}) {
  return {
    attempts: store.attempts && typeof store.attempts === "object" ? store.attempts : {},
    wrong: store.wrong && typeof store.wrong === "object" ? store.wrong : {},
    mastered: store.mastered && typeof store.mastered === "object" ? store.mastered : {},
    seen: store.seen && typeof store.seen === "object" ? store.seen : {},
    favorites: store.favorites && typeof store.favorites === "object" ? store.favorites : {}
  };
}

function byId(id) {
  return document.getElementById(id);
}

function escapeHtml(text) {
  return String(text ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function shuffle(items) {
  const copy = [...items];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

function answerLabel(question) {
  return question.answer.map(letter => {
    const idx = letter.charCodeAt(0) - 65;
    const text = question.options[idx] || "";
    return `${letter}. ${text}`;
  }).join("；");
}

function normalizeAnswer(answer) {
  return [...new Set(answer)].sort().join("");
}

function parseAnswerLetters(value) {
  if (Array.isArray(value)) return [...new Set(value.map(item => String(item).toUpperCase()).filter(item => /^[A-E]$/.test(item)))];
  return [...new Set(String(value || "").toUpperCase().match(/[A-E]/g) || [])];
}

function questionKey(question) {
  return `${question.type}:${String(question.stem || "")
    .replace(/\s+/g, "")
    .replace(/[（(]\s*[）)]/g, "")}`;
}

function isCorrect(question, answer) {
  return normalizeAnswer(question.answer) === normalizeAnswer(answer);
}

function questionById(id) {
  return BANK.find(q => q.id === id);
}

function compareQuestionId(a, b) {
  return QUESTION_ID_COLLATOR.compare(String(a?.id || ""), String(b?.id || ""));
}

function questionPracticeStatus(question) {
  if (question.disputed) return { key: "disputed", label: "答案有争议" };
  const seen = state.store.seen?.[question.id];
  const wrong = state.store.wrong?.[question.id];
  const key = questionKey(question);
  const mastered = state.store.mastered?.[question.id]
    || Object.values(state.store.mastered || {}).some(item => item?.key === key);
  if (wrong || seen?.lastCorrect === false) return { key: "wrong", label: "已做错" };
  if (mastered || seen?.lastCorrect === true) return { key: "correct", label: "已做对" };
  return { key: "unseen", label: "未做过" };
}

function questionIsDone(question) {
  const key = questionKey(question);
  const masteredByKey = Object.values(state.store.mastered || {}).some(item => item?.key === key);
  return Boolean(
    state.store.seen?.[question.id]
    || state.store.attempts?.[question.id]
    || state.store.wrong?.[question.id]
    || state.store.mastered?.[question.id]
    || masteredByKey
  );
}

function questionSource(question) {
  if (String(question.source || "").startsWith("用户新增题库：")) return question.source;
  if (question.bankName) return `用户题库：${question.bankName}`;
  const source = String(question.source || "综合题库").trim();
  if (/机房|模拟题截图版|机房题库原题/.test(source)) return "机房原题";
  if (source === "学长回忆重点") return "学长回忆重点";
  return "其它题库";
}

function timelineSortValue(item) {
  return Number(item.year || String(item.time || "").match(/\d{4}/)?.[0] || 9999);
}

function timelineDefaultOrder(item) {
  const index = BASE_TIMELINE.findIndex(row => row.id === item.id);
  const fallbackIndex = index >= 0 ? index : TIMELINE_DATA.findIndex(row => row.id === item.id);
  return timelineSortValue(item) * 1000 + Math.max(0, fallbackIndex);
}

function timelineOrderValue(item) {
  const order = Number(item.order);
  return Number.isFinite(order) ? order : timelineDefaultOrder(item);
}

function bankById(id) {
  return state.cloud.banks?.[id] || null;
}

function isFavorite(id) {
  return Boolean(state.store.favorites?.[id]);
}

function toggleFavorite(id) {
  const q = questionById(id);
  if (!q) return;
  state.store.favorites = state.store.favorites || {};
  if (state.store.favorites[id]) {
    delete state.store.favorites[id];
  } else {
    state.store.favorites[id] = {
      id,
      key: questionKey(q),
      addedAt: new Date().toISOString()
    };
  }
  saveStore();
  if (state.view === "practice" && state.current?.id === id) renderPractice(state.current, { push: false });
  else refreshCurrentView();
}

function canEditQuestionClient(question) {
  if (!state.user?.token) return false;
  if (state.user.isAdmin) return true;
  if (question.createdBy === state.user.username) return true;
  const bank = bankById(question.bankId);
  if (bank?.createdBy === state.user.username) return true;
  return !question.cloudAdded;
}

function canDeleteQuestionClient(question) {
  if (!state.user?.token) return false;
  if (state.user.isAdmin) return true;
  const bank = bankById(question.bankId);
  return Boolean(question.bankId && bank?.createdBy === state.user.username);
}

function getFilters() {
  return {
    chapter: byId("chapterFilter").value,
    type: byId("typeFilter").value,
    source: byId("sourceFilter").value,
    status: byId("statusFilter").value,
    search: byId("searchInput").value.trim()
  };
}

function filteredBank(opts = {}) {
  const includeDone = Boolean(opts.includeDone || opts.includeMastered);
  const excludeDone = Boolean(opts.excludeDone);
  const ignoreStatus = Boolean(opts.ignoreStatus);
  const filters = getFilters();
  const wrongIds = new Set(Object.keys(state.store.wrong));
  const masteredIds = new Set(Object.keys(state.store.mastered || {}));
  const masteredKeys = new Set(Object.values(state.store.mastered || {}).map(item => item.key).filter(Boolean));
  return BANK.filter(q => {
    if (state.wrongOnly && !wrongIds.has(q.id)) return false;
    const done = questionIsDone(q);
    if (excludeDone && done && !state.wrongOnly) return false;
    if (!includeDone && !state.wrongOnly && (masteredIds.has(q.id) || masteredKeys.has(questionKey(q)))) return false;
    if (!ignoreStatus && filters.status === "done" && !done) return false;
    if (!ignoreStatus && filters.status === "undone" && done) return false;
    if (filters.chapter !== "all" && q.chapter !== filters.chapter) return false;
    if (filters.type !== "all" && q.type !== filters.type) return false;
    if (filters.source !== "all" && questionSource(q) !== filters.source) return false;
    if (filters.search) {
      const blob = `${q.stem} ${q.options.join(" ")} ${q.analysis} ${Object.values(q.optionAnalysis || {}).join(" ")} ${q.chapter} ${questionSource(q)} ${q.page || ""} ${q.id}`;
      if (!blob.includes(filters.search)) return false;
    }
    return true;
  });
}

function initFilters(preserve = false) {
  const chapterFilter = byId("chapterFilter");
  const sourceFilter = byId("sourceFilter");
  const statusFilter = byId("statusFilter");
  const current = preserve ? chapterFilter.value : "all";
  const currentSource = preserve ? sourceFilter.value : "all";
  const currentStatus = preserve ? statusFilter.value : "all";
  const chapters = ["all", ...new Set(BANK.map(q => q.chapter || "综合"))];
  const discoveredSources = [...new Set(BANK.map(questionSource).filter(Boolean))];
  const sources = [
    "all",
    ...SOURCE_ORDER.filter(source => discoveredSources.includes(source)),
    ...discoveredSources
      .filter(source => !SOURCE_ORDER.includes(source))
      .sort((a, b) => a.localeCompare(b, "zh-Hans-CN"))
  ];
  chapterFilter.innerHTML = chapters.map(ch => {
    const label = ch === "all" ? "全部章节" : ch;
    return `<option value="${escapeHtml(ch)}">${escapeHtml(label)}</option>`;
  }).join("");
  sourceFilter.innerHTML = sources.map(source => {
    const label = source === "all" ? "全部来源" : source;
    return `<option value="${escapeHtml(source)}">${escapeHtml(label)}</option>`;
  }).join("");
  chapterFilter.value = chapters.includes(current) ? current : "all";
  sourceFilter.value = sources.includes(currentSource) ? currentSource : "all";
  statusFilter.value = ["all", "done", "undone"].includes(currentStatus) ? currentStatus : "all";
}

function resetQuestionFilters() {
  byId("chapterFilter").value = "all";
  byId("typeFilter").value = "all";
  byId("sourceFilter").value = "all";
  byId("statusFilter").value = "all";
  byId("searchInput").value = "";
}

function renderStats() {
  const counts = {
    single: BANK.filter(q => q.type === "single").length,
    multi: BANK.filter(q => q.type === "multi").length,
    judge: BANK.filter(q => q.type === "judge").length
  };
  byId("totalCount").textContent = BANK.length;
  byId("singleCount").textContent = counts.single;
  byId("multiCount").textContent = counts.multi;
  byId("judgeCount").textContent = counts.judge;
  byId("wrongCount").textContent = Object.keys(state.store.wrong).length;
  byId("doneCount").textContent = Object.keys(state.store.mastered || {}).length;
  const attempts = Object.values(state.store.attempts);
  if (!attempts.length) {
    byId("accuracy").textContent = "--";
  } else {
    const total = attempts.reduce((sum, item) => sum + item.total, 0);
    const correct = attempts.reduce((sum, item) => sum + item.correct, 0);
    byId("accuracy").textContent = `${Math.round(correct / total * 100)}%`;
  }
}

function setCloudStatus(text, mode = "") {
  const el = byId("cloudStatus");
  el.textContent = text;
  el.classList.toggle("online", mode === "online");
  el.classList.toggle("error", mode === "error");
}

function renderAccountPanel() {
  const signedIn = Boolean(state.user?.token);
  byId("accountSignedOut").classList.toggle("hidden", signedIn);
  byId("accountSignedIn").classList.toggle("hidden", !signedIn);
  byId("addQuestionBtn").classList.toggle("hidden", !signedIn);
  byId("bulkImportBtn").classList.toggle("hidden", !signedIn);
  byId("addTimelineBtn").classList.toggle("hidden", !signedIn);
  byId("addKeypointBtn").classList.toggle("hidden", !signedIn);
  byId("manageNav").classList.toggle("hidden", !signedIn);
  byId("currentUser").textContent = signedIn ? state.user.username : "--";
  byId("postDiscussionBtn").disabled = !signedIn;
  byId("discussionHint").textContent = signedIn ? `以 ${state.user.username} 身份发言。` : "注册或登录后可发言。";
  if (signedIn) setCloudStatus(state.syncing ? "同步中" : "已登录", "online");
  else setCloudStatus("本地");
  refreshIcons();
}

function setView(view) {
  state.view = view;
  document.querySelectorAll(".nav-btn").forEach(btn => {
    btn.classList.toggle("active", btn.dataset.view === view);
  });
  document.querySelectorAll(".view").forEach(el => el.classList.remove("active"));
  byId(`${view}View`).classList.add("active");
  const titles = { practice: "练习模式", exam: "模拟考试", wrong: "错题本", studied: "已练习题目", favorites: "我的收藏", browse: "题库浏览", timeline: "文献会议时间线", keypoints: "章节重点", about: "版本说明与使用说明", discussion: "讨论区", manage: "题库与账号管理" };
  byId("viewTitle").textContent = titles[view];
  if (view === "practice") renderPractice();
  if (view === "wrong") renderWrong();
  if (view === "studied") renderStudied();
  if (view === "favorites") renderFavorites();
  if (view === "browse") renderBrowse();
  if (view === "timeline") renderTimeline();
  if (view === "keypoints") renderKeypoints();
  if (view === "discussion") {
    renderDiscussion();
    loadDiscussion().then(renderDiscussion);
  }
  if (view === "manage") {
    renderManage();
    if (state.user?.isAdmin) loadAdminData().then(renderManage);
  }
  renderStats();
}

function optionInput(question, index, checked = false, disabled = false) {
  const letter = String.fromCharCode(65 + index);
  const type = question.type === "multi" ? "checkbox" : "radio";
  const name = `q_${question.id}`;
  return `
    <label class="option" data-letter="${letter}">
      <input type="${type}" name="${name}" value="${letter}" ${checked ? "checked" : ""} ${disabled ? "disabled" : ""}>
      <span><strong>${letter}.</strong> ${escapeHtml(question.options[index])}</span>
    </label>
  `;
}

function questionCard(question, context = "practice", opts = {}) {
  const disabled = Boolean(opts.disabled);
  const selected = opts.selected || [];
  const showAnalysis = Boolean(opts.showAnalysis);
  const result = showAnalysis && selected.length ? isCorrect(question, selected) : null;
  const editable = context !== "exam" && canEditQuestionClient(question);
  const deletable = context !== "exam" && canDeleteQuestionClient(question);
  const favorite = isFavorite(question.id);
  const canFavorite = context !== "exam";
  const disputeHtml = question.disputed ? `
    <div class="dispute-warning">
      <strong>答案有争议</strong>
      <span>${escapeHtml(question.disputeNote || (question.aiAnswer?.length ? `AI 判断答案：${question.aiAnswer.join("")}` : "AI 复核结果与原答案不一致，需人工确认。"))}</span>
    </div>
  ` : "";
  const optionHtml = question.options.map((_, index) => {
    const letter = String.fromCharCode(65 + index);
    return optionInput(question, index, selected.includes(letter), disabled);
  }).join("");
  const optionAnalysisHtml = showAnalysis && question.optionAnalysis ? `
    <div class="option-analysis">
      ${question.options.map((_, index) => {
        const letter = String.fromCharCode(65 + index);
        const ok = question.answer.includes(letter);
        const text = question.optionAnalysis[letter] || "";
        return `<div class="option-note ${ok ? "right" : "wrong"}"><strong>${letter}</strong><span>${escapeHtml(text)}</span></div>`;
      }).join("")}
    </div>
  ` : "";
  const resultHtml = showAnalysis ? `
      <div class="analysis">
      <div class="${result ? "result-ok" : "result-bad"}">${result ? "答对了" : "答错了"}，正确答案：${escapeHtml(answerLabel(question))}</div>
      ${disputeHtml}
      <div>${escapeHtml(question.analysis)}</div>
      <div>来源：${escapeHtml(questionSource(question))}${question.page ? ` · 课本页码：${escapeHtml(question.page)}` : ""}</div>
      <div class="analysis-help">如果遇到题目乱码问题，请在讨论区回复。</div>
      ${optionAnalysisHtml}
    </div>
  ` : "";
  const actions = context === "practice" ? `
    <div class="question-actions">
      <button class="soft-btn" data-action="prev"><i data-lucide="skip-back"></i><span>上一题</span></button>
      <button class="soft-btn" data-action="next"><i data-lucide="skip-forward"></i><span>换下一题</span></button>
      <button class="primary-btn" data-action="submit-one"><i data-lucide="check"></i><span>提交本题</span></button>
    </div>
  ` : "";
  return `
    <article class="question-card" data-qid="${question.id}">
      <div class="question-head">
        <div class="badges">
          <span class="badge ${TYPE_CLASS[question.type]}">${TYPE_LABEL[question.type]}</span>
          <span class="badge chapter">${escapeHtml(question.chapter || "综合")}</span>
          ${question.disputed ? `<span class="badge dispute">答案有争议</span>` : ""}
        </div>
        <div class="head-actions">
          <span class="badge">#${escapeHtml(question.id)}</span>
          ${canFavorite ? `<button class="icon-btn ${favorite ? "is-favorite" : ""}" data-action="toggle-favorite" data-id="${escapeHtml(question.id)}" title="${favorite ? "取消收藏" : "收藏题目"}"><i data-lucide="star"></i></button>` : ""}
          ${editable ? `<button class="icon-btn" data-action="edit-question" data-id="${escapeHtml(question.id)}" title="编辑题目"><i data-lucide="pencil"></i></button>` : ""}
          ${deletable ? `<button class="icon-btn" data-action="delete-question" data-id="${escapeHtml(question.id)}" title="删除题目"><i data-lucide="trash-2"></i></button>` : ""}
        </div>
      </div>
      <div class="question-body">
        <p class="stem">${escapeHtml(question.stem)}</p>
        <div class="options">${optionHtml}</div>
        ${resultHtml}
      </div>
      ${actions}
    </article>
  `;
}

function getSelectedFromCard(card) {
  return [...card.querySelectorAll("input:checked")].map(input => input.value);
}

function paintOptions(card, question, selected) {
  card.querySelectorAll(".option").forEach(option => {
    const letter = option.dataset.letter;
    option.classList.toggle("correct", question.answer.includes(letter));
    option.classList.toggle("wrong", selected.includes(letter) && !question.answer.includes(letter));
  });
}

function removeMastered(question) {
  const key = questionKey(question);
  for (const [id, item] of Object.entries(state.store.mastered || {})) {
    if (id === question.id || item.key === key) delete state.store.mastered[id];
  }
}

function recordAttempt(question, selected) {
  const ok = isCorrect(question, selected);
  const item = state.store.attempts[question.id] || { total: 0, correct: 0 };
  item.total += 1;
  if (ok) item.correct += 1;
  item.lastAt = new Date().toISOString();
  item.lastAnswer = selected;
  item.lastCorrect = ok;
  state.store.attempts[question.id] = item;
  state.store.seen = state.store.seen || {};
  state.store.seen[question.id] = {
    id: question.id,
    key: questionKey(question),
    lastAnswer: selected,
    lastCorrect: ok,
    lastAt: item.lastAt,
    total: item.total,
    correct: item.correct
  };
  if (!ok) {
    removeMastered(question);
    state.store.wrong[question.id] = {
      id: question.id,
      lastAnswer: selected,
      lastAt: new Date().toISOString(),
      count: (state.store.wrong[question.id]?.count || 0) + 1
    };
  } else {
    state.store.mastered[question.id] = {
      id: question.id,
      key: questionKey(question),
      masteredAt: new Date().toISOString()
    };
    delete state.store.wrong[question.id];
  }
  saveStore();
  renderStats();
  return ok;
}

function pickPracticeQuestion() {
  const pool = filteredBank({ excludeDone: true, ignoreStatus: true });
  if (!pool.length) return null;
  return shuffle(pool)[0];
}

function pushPracticeHistory(question) {
  if (!question) return;
  if (state.practiceHistory[state.practiceHistoryIndex]?.id === question.id) return;
  state.practiceHistory = state.practiceHistory.slice(0, state.practiceHistoryIndex + 1);
  state.practiceHistory.push(question);
  state.practiceHistoryIndex = state.practiceHistory.length - 1;
}

function renderPractice(question = null, opts = {}) {
  const q = question || pickPracticeQuestion();
  state.current = q;
  if (!q) {
    const message = state.wrongOnly
      ? "错题本为空，或当前筛选条件下没有可练习的错题。"
      : "当前筛选条件下没有未做过题目。练习模式不会随机出现已经做过的题，考试模式不受此限制。";
    byId("practiceCard").innerHTML = `<div class="empty">${message}</div>`;
    return;
  }
  if (opts.push !== false) pushPracticeHistory(q);
  byId("practiceCard").innerHTML = questionCard(q, "practice");
  refreshIcons();
}

function renderPreviousPractice() {
  if (state.practiceHistoryIndex <= 0) {
    alert("没有上一题。");
    return;
  }
  state.practiceHistoryIndex -= 1;
  renderPractice(state.practiceHistory[state.practiceHistoryIndex], { push: false });
}

function submitPractice() {
  const card = byId("practiceCard").querySelector(".question-card");
  if (!card || !state.current) return;
  const selected = getSelectedFromCard(card);
  if (!selected.length) {
    alert("先选择答案。");
    return;
  }
  recordAttempt(state.current, selected);
  byId("practiceCard").innerHTML = questionCard(state.current, "practice", {
    selected,
    showAnalysis: true,
    disabled: true
  });
  paintOptions(byId("practiceCard"), state.current, selected);
  refreshIcons();
}

function startExam() {
  const single = Number(byId("examSingle").value || 0);
  const multi = Number(byId("examMulti").value || 0);
  const judge = Number(byId("examJudge").value || 0);
  const pool = filteredBank({ includeDone: true });
  const take = (type, count) => shuffle(pool.filter(q => q.type === type)).slice(0, count);
  state.exam = shuffle([...take("single", single), ...take("multi", multi), ...take("judge", judge)]);
  state.examSubmitted = false;
  byId("submitExamBtn").disabled = !state.exam.length;
  byId("examSummary").textContent = state.exam.length ? `本卷 ${state.exam.length} 题。交卷前不会显示答案。` : "当前筛选条件下没有可生成的试题。";
  renderExam();
}

function renderExam(results = null) {
  if (!state.exam.length) {
    byId("examList").innerHTML = `<div class="empty">点击“生成试卷”开始。</div>`;
    return;
  }
  byId("examList").innerHTML = state.exam.map((q, index) => {
    const selected = results?.[q.id]?.selected || [];
    const show = Boolean(results);
    return `<div class="exam-item"><div class="question-index">第 ${index + 1} 题</div>${questionCard(q, "exam", { selected, showAnalysis: show, disabled: show })}</div>`;
  }).join("");
  if (results) {
    state.exam.forEach(q => {
      const wrapper = byId("examList").querySelector(`[data-qid="${q.id}"]`);
      if (wrapper) paintOptions(wrapper, q, results[q.id].selected);
    });
  }
  refreshIcons();
}

function submitExam() {
  if (!state.exam.length) return;
  const results = {};
  let correct = 0;
  for (const q of state.exam) {
    const card = byId("examList").querySelector(`[data-qid="${q.id}"]`);
    const selected = card ? getSelectedFromCard(card) : [];
    const ok = recordAttempt(q, selected);
    if (ok) correct += 1;
    results[q.id] = { selected, ok };
  }
  state.examSubmitted = true;
  byId("examSummary").innerHTML = `得分：<strong>${correct}/${state.exam.length}</strong>，正确率 ${Math.round(correct / state.exam.length * 100)}%。错题已自动加入错题本。`;
  byId("submitExamBtn").disabled = true;
  renderExam(results);
}

function renderWrong() {
  const wrongIds = Object.keys(state.store.wrong);
  const questions = wrongIds.map(id => questionById(id)).filter(Boolean);
  byId("wrongCount").textContent = questions.length;
  if (!questions.length) {
    byId("wrongList").innerHTML = `<div class="empty">错题本是空的。做错题后会自动记录在这里。</div>`;
    byId("wrongPager").innerHTML = "";
    return;
  }
  const totalPages = Math.max(1, Math.ceil(questions.length / COLLECTION_PAGE_SIZE));
  state.wrongPage = Math.min(Math.max(1, state.wrongPage || 1), totalPages);
  const pageQuestions = questions.slice((state.wrongPage - 1) * COLLECTION_PAGE_SIZE, state.wrongPage * COLLECTION_PAGE_SIZE);
  byId("wrongList").innerHTML = pageQuestions.map(q => {
    const meta = state.store.wrong[q.id];
    return `
      <div class="browse-item" data-qid="${q.id}">
        ${questionCard(q, "browse", { showAnalysis: true, selected: meta.lastAnswer || [], disabled: true })}
        <div class="question-actions">
          <span>错误次数：${meta.count || 1}</span>
          <button class="soft-btn" data-action="remove-wrong" data-id="${q.id}"><i data-lucide="x"></i><span>移出错题本</span></button>
        </div>
      </div>
    `;
  }).join("");
  pageQuestions.forEach(q => {
    const card = byId("wrongList").querySelector(`[data-qid="${q.id}"] .question-card`);
    paintOptions(card, q, state.store.wrong[q.id].lastAnswer || []);
  });
  byId("wrongPager").innerHTML = pagerHtml("wrong-page", state.wrongPage, totalPages, `${questions.length} 道错题`);
  refreshIcons();
}

function renderQuestionCollection(containerId, countId, pagerId, pageKey, pagerAction, entries, emptyText, metaGetter, actionGetter = null) {
  const questions = entries.map(entry => questionById(entry.id)).filter(Boolean);
  byId(countId).textContent = `${questions.length} 题`;
  if (!questions.length) {
    byId(containerId).innerHTML = `<div class="empty">${emptyText}</div>`;
    byId(pagerId).innerHTML = "";
    return;
  }
  const totalPages = Math.max(1, Math.ceil(questions.length / COLLECTION_PAGE_SIZE));
  state[pageKey] = Math.min(Math.max(1, state[pageKey] || 1), totalPages);
  const pageQuestions = questions.slice((state[pageKey] - 1) * COLLECTION_PAGE_SIZE, state[pageKey] * COLLECTION_PAGE_SIZE);
  byId(containerId).innerHTML = pageQuestions.map(q => {
    const meta = metaGetter(q) || {};
    const selected = meta.lastAnswer || q.answer;
    return `
      <div class="browse-item" data-qid="${q.id}">
        ${questionCard(q, "browse", { showAnalysis: true, selected, disabled: true })}
        <div class="question-actions">
          <span>${escapeHtml(meta.label || "")}</span>
          <button class="soft-btn" data-action="practice-this" data-id="${escapeHtml(q.id)}"><i data-lucide="play"></i><span>练这题</span></button>
          ${actionGetter ? actionGetter(q, meta) : ""}
        </div>
      </div>
    `;
  }).join("");
  pageQuestions.forEach(q => {
    const meta = metaGetter(q) || {};
    const card = byId(containerId).querySelector(`[data-qid="${q.id}"] .question-card`);
    if (card) paintOptions(card, q, meta.lastAnswer || q.answer);
  });
  byId(pagerId).innerHTML = pagerHtml(pagerAction, state[pageKey], totalPages, `${questions.length} 题`);
  refreshIcons();
}

function renderStudied() {
  const entries = Object.values(state.store.seen || {})
    .sort((a, b) => Date.parse(b.lastAt || "") - Date.parse(a.lastAt || ""));
  renderQuestionCollection("studiedList", "studiedCount", "studiedPager", "studiedPage", "studied-page", entries, "还没有练习记录。提交题目后会自动出现在这里。", q => {
    const meta = state.store.seen[q.id] || {};
    const status = meta.lastCorrect ? "上次答对" : "上次答错";
    return { ...meta, label: `${status} · 共练 ${meta.total || 1} 次 · ${meta.lastAt || ""}` };
  }, q => `<button class="soft-btn" data-action="requeue-question" data-id="${escapeHtml(q.id)}"><i data-lucide="rotate-ccw"></i><span>加入随机池</span></button>`);
}

function renderFavorites() {
  const entries = Object.values(state.store.favorites || {})
    .sort((a, b) => Date.parse(b.addedAt || "") - Date.parse(a.addedAt || ""));
  renderQuestionCollection("favoritesList", "favoritesCount", "favoritesPager", "favoritesPage", "favorites-page", entries, "还没有收藏题目。点击题目右上角星标即可收藏。", q => {
    const meta = state.store.favorites[q.id] || {};
    return { ...meta, label: `收藏时间：${meta.addedAt || "--"}` };
  });
}

function renderBrowse() {
  const questions = filteredBank({ includeDone: true }).sort(compareQuestionId);
  const totalPages = Math.max(1, Math.ceil(questions.length / BROWSE_PAGE_SIZE));
  state.browsePage = Math.min(Math.max(1, state.browsePage || 1), totalPages);
  const start = (state.browsePage - 1) * BROWSE_PAGE_SIZE;
  const pageQuestions = questions.slice(start, start + BROWSE_PAGE_SIZE);
  byId("browseCount").textContent = `${questions.length} 题 · 第 ${state.browsePage}/${totalPages} 页`;
  if (!questions.length) {
    byId("browseList").innerHTML = `<div class="empty">没有匹配题目。</div>`;
    byId("browsePager").innerHTML = "";
    return;
  }
  byId("browseList").innerHTML = pageQuestions.map(q => {
    const status = questionPracticeStatus(q);
    return `
    <details class="browse-item browse-status-${status.key}">
      <summary>
        <span class="badge chapter">#${escapeHtml(q.id)}</span>
        <span class="badge ${TYPE_CLASS[q.type]}">${TYPE_LABEL[q.type]}</span>
        <span>${escapeHtml(q.stem)}</span>
        <span class="browse-status-label">${escapeHtml(status.label)}</span>
      </summary>
      ${questionCard(q, "browse", { showAnalysis: true, selected: q.answer, disabled: true })}
    </details>
  `;
  }).join("");
  pageQuestions.forEach(q => {
    const card = byId("browseList").querySelector(`[data-qid="${q.id}"]`);
    if (card) paintOptions(card, q, q.answer);
  });
  byId("browsePager").innerHTML = pagerHtml("browse-page", state.browsePage, totalPages);
  refreshIcons();
}

function changeBrowsePage(direction) {
  const questions = filteredBank({ includeDone: true });
  const totalPages = Math.max(1, Math.ceil(questions.length / BROWSE_PAGE_SIZE));
  if (direction === "prev") state.browsePage = Math.max(1, state.browsePage - 1);
  else if (direction === "next") state.browsePage = Math.min(totalPages, state.browsePage + 1);
  else state.browsePage = Math.min(totalPages, Math.max(1, Number(direction || 1)));
  renderBrowse();
}

function changeCollectionPage(pageKey, renderFn, direction) {
  const current = state[pageKey] || 1;
  if (direction === "prev") state[pageKey] = Math.max(1, current - 1);
  else if (direction === "next") state[pageKey] = current + 1;
  else state[pageKey] = Math.max(1, Number(direction || 1));
  renderFn();
}

function pageFromDirection(current, totalPages, direction) {
  if (direction === "prev") return Math.max(1, current - 1);
  if (direction === "next") return Math.min(totalPages, current + 1);
  return Math.min(totalPages, Math.max(1, Number(direction || 1)));
}

function pagerHtml(action, page, totalPages, totalLabel = "") {
  return `
    <button class="soft-btn" data-action="${action}" data-page="prev" ${page <= 1 ? "disabled" : ""}><i data-lucide="chevron-left"></i><span>上一页</span></button>
    <span>${escapeHtml(totalLabel ? `${totalLabel} · ` : "")}第 ${page} / ${totalPages} 页</span>
    <button class="soft-btn" data-action="${action}" data-page="next" ${page >= totalPages ? "disabled" : ""}><span>下一页</span><i data-lucide="chevron-right"></i></button>
  `;
}

function removeWrong(id) {
  delete state.store.wrong[id];
  saveStore();
  renderWrong();
  renderStats();
}

function requeueQuestion(id) {
  const question = questionById(id);
  if (!question) return;
  const key = questionKey(question);
  delete state.store.seen[id];
  delete state.store.attempts[id];
  delete state.store.wrong[id];
  delete state.store.mastered[id];
  for (const [masteredId, item] of Object.entries(state.store.mastered || {})) {
    if (item?.key === key) delete state.store.mastered[masteredId];
  }
  saveStore();
  renderStudied();
  renderStats();
}

function resetMastered() {
  const count = Object.keys(state.store.mastered || {}).length;
  if (!count) {
    alert("当前没有已掌握记录。");
    return;
  }
  if (!confirm(`确定重置 ${count} 道已掌握题吗？重置后它们会重新进入随机抽题池，错题本不会被清空。`)) return;
  state.store.mastered = {};
  saveStore();
  refreshCurrentView();
}

function exportWrong() {
  const wrongIds = Object.keys(state.store.wrong);
  const lines = wrongIds.map((id, index) => {
    const q = questionById(id);
    if (!q) return "";
    const meta = state.store.wrong[id];
    return [
      `${index + 1}. [${TYPE_LABEL[q.type]}][${q.chapter}] ${q.stem}`,
      `正确答案：${answerLabel(q)}`,
      `上次作答：${(meta.lastAnswer || []).join(", ") || "未记录"}`,
      `解析：${q.analysis}`,
      ""
    ].join("\n");
  }).join("\n");
  const blob = new Blob([lines || "错题本为空。"], { type: "text/plain;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "毛概错题本.txt";
  a.click();
  URL.revokeObjectURL(url);
}

async function apiRequest(url, options = {}) {
  const headers = {
    "content-type": "application/json",
    ...(options.headers || {})
  };
  if (state.user?.token) headers.authorization = `Bearer ${state.user.token}`;
  const response = await fetch(url, { ...options, headers });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || data.ok === false) {
    throw new Error(data.message || "云端请求失败");
  }
  return data;
}

function mergeStores(remoteStore, localStore) {
  const remote = normalizeStore(remoteStore);
  const local = normalizeStore(localStore);
  const merged = emptyStore();
  const attemptIds = new Set([...Object.keys(remote.attempts), ...Object.keys(local.attempts)]);
  attemptIds.forEach(id => {
    const a = remote.attempts[id] || {};
    const b = local.attempts[id] || {};
    const newest = Date.parse(b.lastAt || "") >= Date.parse(a.lastAt || "") ? b : a;
    merged.attempts[id] = {
      total: Math.max(Number(a.total || 0), Number(b.total || 0)),
      correct: Math.max(Number(a.correct || 0), Number(b.correct || 0)),
      lastAt: newest.lastAt || "",
      lastAnswer: newest.lastAnswer || [],
      lastCorrect: Boolean(newest.lastCorrect)
    };
  });
  merged.mastered = { ...remote.mastered, ...local.mastered };
  merged.favorites = { ...remote.favorites, ...local.favorites };
  const seenIds = new Set([...Object.keys(remote.seen), ...Object.keys(local.seen)]);
  seenIds.forEach(id => {
    const a = remote.seen[id];
    const b = local.seen[id];
    if (!a) merged.seen[id] = b;
    else if (!b) merged.seen[id] = a;
    else merged.seen[id] = Date.parse(b.lastAt || "") >= Date.parse(a.lastAt || "") ? { ...a, ...b } : { ...b, ...a };
  });
  const wrongIds = new Set([...Object.keys(remote.wrong), ...Object.keys(local.wrong)]);
  wrongIds.forEach(id => {
    const a = remote.wrong[id];
    const b = local.wrong[id];
    if (!a) merged.wrong[id] = b;
    else if (!b) merged.wrong[id] = a;
    else merged.wrong[id] = Date.parse(b.lastAt || "") >= Date.parse(a.lastAt || "") ? { ...a, ...b, count: Math.max(a.count || 1, b.count || 1) } : { ...b, ...a, count: Math.max(a.count || 1, b.count || 1) };
  });
  Object.keys(merged.wrong).forEach(id => {
    const wrongAt = Date.parse(merged.wrong[id]?.lastAt || "");
    const masteredAt = Date.parse(merged.mastered[id]?.masteredAt || "");
    if (masteredAt && masteredAt >= wrongAt) delete merged.wrong[id];
    else if (wrongAt) delete merged.mastered[id];
  });
  return merged;
}

function queueCloudSave() {
  if (!state.user?.token) return;
  clearTimeout(cloudSaveTimer);
  cloudSaveTimer = setTimeout(pushProgress, 650);
}

async function pushProgress() {
  if (!state.user?.token) return;
  try {
    state.syncing = true;
    renderAccountPanel();
    await apiRequest(API.progress, {
      method: "PUT",
      body: JSON.stringify({ store: state.store })
    });
    state.syncing = false;
    renderAccountPanel();
  } catch (error) {
    state.syncing = false;
    setCloudStatus("同步失败", "error");
  }
}

async function syncProgressAfterAuth() {
  if (!state.user?.token) return;
  try {
    state.syncing = true;
    renderAccountPanel();
    const data = await apiRequest(API.progress);
    state.store = mergeStores(data.store || {}, state.store);
    saveStore({ sync: false });
    await pushProgress();
    refreshCurrentView();
  } finally {
    state.syncing = false;
    renderAccountPanel();
  }
}

function normalizeCloudQuestion(question) {
  const q = { ...question };
  q.type = ["single", "multi", "judge"].includes(q.type) ? q.type : "single";
  q.options = Array.isArray(q.options) ? q.options : [];
  q.answer = parseAnswerLetters(q.answer).filter(letter => letter.charCodeAt(0) - 65 < q.options.length);
  q.optionAnalysis = q.optionAnalysis && typeof q.optionAnalysis === "object" ? q.optionAnalysis : {};
  q.chapter = q.chapter || "用户题库";
  q.source = q.source || "用户补充题库";
  if (q.bankId && state.cloud.banks?.[q.bankId]) {
    q.bankName = q.bankName || state.cloud.banks[q.bankId].name;
    if (!String(q.source || "").startsWith("用户新增题库：")) q.source = `用户题库：${q.bankName}`;
  }
  return q;
}

function applyCloudQuestions(payload = {}) {
  const patches = payload.patches && typeof payload.patches === "object" ? payload.patches : {};
  const deleted = payload.deleted && typeof payload.deleted === "object" ? payload.deleted : {};
  const banks = payload.banks && typeof payload.banks === "object" ? payload.banks : {};
  const additions = Array.isArray(payload.additions) ? payload.additions : [];
  state.cloud = {
    version: payload.version || 0,
    additions,
    patches,
    deleted,
    banks
  };
  BANK = BASE_BANK.filter(question => !deleted[question.id]).map(question => {
    const patch = patches[question.id];
    return patch ? normalizeCloudQuestion({ ...question, ...patch, id: question.id, cloudEdited: true }) : question;
  });
  const existingIds = new Set(BANK.map(q => q.id));
  additions.forEach(item => {
    if (item?.id && !existingIds.has(item.id) && !deleted[item.id]) {
      const patch = patches[item.id] || {};
      BANK.push(normalizeCloudQuestion({ ...item, ...patch, id: item.id, cloudAdded: true }));
      existingIds.add(item.id);
    }
  });
}

async function syncCloudQuestions() {
  try {
    const data = await apiRequest(API.questions, { method: "GET" });
    applyCloudQuestions(data);
    initFilters(true);
    refreshCurrentView();
  } catch {
    applyCloudQuestions({});
  }
}

function normalizeContentBucket(bucket = {}) {
  return {
    additions: Array.isArray(bucket.additions) ? bucket.additions : [],
    patches: bucket.patches && typeof bucket.patches === "object" ? bucket.patches : {},
    deleted: bucket.deleted && typeof bucket.deleted === "object" ? bucket.deleted : {}
  };
}

function mergeContentItems(baseItems, bucket) {
  const normalized = normalizeContentBucket(bucket);
  const items = baseItems
    .filter(item => !normalized.deleted[item.id])
    .map(item => normalized.patches[item.id] ? { ...item, ...normalized.patches[item.id], id: item.id, cloudEdited: true } : item);
  const ids = new Set(items.map(item => item.id));
  normalized.additions.forEach(item => {
    if (item?.id && !ids.has(item.id) && !normalized.deleted[item.id]) {
      items.push({ ...item, cloudAdded: true });
      ids.add(item.id);
    }
  });
  return items;
}

function applyContentCloud(payload = {}) {
  const timeline = normalizeContentBucket(payload.timeline);
  const keypoints = normalizeContentBucket(payload.keypoints);
  state.contentCloud = { version: payload.version || 0, timeline, keypoints };
  TIMELINE_DATA = mergeContentItems(BASE_TIMELINE, timeline);
  KEYPOINTS_DATA = mergeContentItems(BASE_KEYPOINTS, keypoints);
}

async function syncContentCloud() {
  try {
    const data = await apiRequest(API.content, { method: "GET" });
    applyContentCloud(data);
    initTimelineFilters(true);
    initKeypointFilters(true);
    refreshCurrentView();
  } catch {
    applyContentCloud({});
  }
}

async function authenticate(action) {
  const username = byId("accountName").value.trim();
  const password = byId("accountPassword").value;
  try {
    const data = await apiRequest(API.auth, {
      method: "POST",
      body: JSON.stringify({ action, username, password })
    });
    state.user = { username: data.user.username, token: data.token, isAdmin: Boolean(data.user.isAdmin) };
    saveAuth(state.user);
    byId("accountPassword").value = "";
    renderAccountPanel();
    await syncCloudQuestions();
    await syncContentCloud();
    await syncProgressAfterAuth();
    if (state.user.isAdmin) await loadAdminData();
  } catch (error) {
    setCloudStatus("失败", "error");
    alert(error.message);
  }
}

function logout() {
  state.user = null;
  saveAuth(null);
  renderAccountPanel();
  if (state.view === "manage") setView("practice");
  refreshCurrentView();
}

async function refreshAuthInfo() {
  if (!state.user?.token) return;
  try {
    const data = await apiRequest(API.auth, { method: "GET" });
    state.user = { ...state.user, username: data.user.username, isAdmin: Boolean(data.user.isAdmin) };
    saveAuth(state.user);
  } catch {
    state.user = null;
    saveAuth(null);
  }
  renderAccountPanel();
}

function optionAnalysisToText(optionAnalysis = {}) {
  return Object.keys(optionAnalysis)
    .sort()
    .map(letter => `${letter}=${optionAnalysis[letter]}`)
    .join("\n");
}

function parseOptionAnalysis(text) {
  const result = {};
  String(text || "").split(/\n+/).forEach(line => {
    const match = line.match(/^\s*([A-E])\s*[=:：]\s*(.+)$/i);
    if (match) result[match[1].toUpperCase()] = match[2].trim();
  });
  return result;
}

function duplicateText(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[【】（）()《》“”"'\s，,。.:：；;、？?！!]/g, "");
}

function duplicateQuestionKey(question) {
  return [
    question.type,
    duplicateText(question.stem),
    (question.options || []).map(duplicateText).join("|")
  ].join("::");
}

function existingQuestionKeySet() {
  return new Set(BANK.map(duplicateQuestionKey));
}

function typeFromText(value) {
  const text = String(value || "");
  if (text.includes("多")) return "multi";
  if (text.includes("判")) return "judge";
  return "single";
}

function parseLabeledValue(block, label) {
  const pattern = new RegExp(`【${label}】\\s*([\\s\\S]*?)(?=\\n\\s*【[^】]+】|\\n\\s*[A-E][\\.\\、．\\s]+|$)`);
  return block.match(pattern)?.[1]?.trim() || "";
}

function parseBulkQuestions(text, defaults = {}) {
  const blocks = String(text || "").split(/\n\s*---+\s*\n/g).map(block => block.trim()).filter(Boolean);
  const questions = [];
  const errors = [];
  blocks.forEach((block, index) => {
    const lines = block.split(/\n+/).map(line => line.trim()).filter(Boolean);
    const type = typeFromText(parseLabeledValue(block, "题型"));
    let stem = parseLabeledValue(block, "题干");
    const chapter = parseLabeledValue(block, "章节") || defaults.chapter || "用户新增题库";
    const page = parseLabeledValue(block, "页码") || defaults.page || "";
    const answer = parseAnswerLetters(parseLabeledValue(block, "答案"));
    const analysis = parseLabeledValue(block, "解析") || "用户批量导入题目，暂无解析。";
    const options = [];
    for (const line of lines) {
      const option = line.match(/^([A-E])[\.\、．\s]+(.+)$/i);
      if (option) options[option[1].toUpperCase().charCodeAt(0) - 65] = option[2].trim();
    }
    if (!stem) {
      const first = lines.find(line => !line.startsWith("【") && !/^[A-E][\.\、．\s]+/i.test(line));
      stem = first || "";
    }
    const cleanedOptions = options.filter(Boolean);
    if (!stem || cleanedOptions.length < 2 || !answer.length) {
      errors.push(`第 ${index + 1} 段解析失败：需要题干、至少两个选项和答案。`);
      return;
    }
    questions.push({
      type,
      chapter,
      stem,
      options: type === "judge" && cleanedOptions.length < 2 ? ["正确", "错误"] : cleanedOptions,
      answer,
      page,
      analysis,
      optionAnalysis: {},
      source: `用户新增题库：${defaults.bankName || "未命名"}`
    });
  });
  return { questions, errors };
}

function previewBulkImport() {
  const bankName = byId("bulkBankName").value.trim() || "未命名";
  const parsed = parseBulkQuestions(byId("bulkImportText").value, {
    bankName,
    chapter: byId("bulkDefaultChapter").value.trim(),
    page: byId("bulkDefaultPage").value.trim()
  });
  const existing = existingQuestionKeySet();
  const seen = new Set();
  let duplicates = 0;
  const rows = parsed.questions.map((q, index) => {
    const key = duplicateQuestionKey(q);
    const dup = existing.has(key) || seen.has(key);
    if (dup) duplicates += 1;
    seen.add(key);
    return `<div class="preview-row ${dup ? "duplicate" : ""}"><strong>${index + 1}. ${escapeHtml(q.stem)}</strong><span>${escapeHtml(TYPE_LABEL[q.type])} · ${escapeHtml(q.answer.join(""))}${dup ? " · 重复，将跳过" : ""}</span></div>`;
  }).join("");
  byId("bulkPreview").innerHTML = `
    <div class="summary-line">解析出 ${parsed.questions.length} 道，重复 ${duplicates} 道，格式错误 ${parsed.errors.length} 段。</div>
    ${parsed.errors.map(error => `<div class="result-bad">${escapeHtml(error)}</div>`).join("")}
    ${rows || `<div class="empty">还没有解析出题目。</div>`}
  `;
  return parsed;
}

function openBulkImport() {
  if (!state.user?.token) return alert("请先登录账号。");
  byId("bulkImportModal").classList.remove("hidden");
  byId("bulkPreview").innerHTML = "";
  refreshIcons();
}

function closeBulkImport() {
  byId("bulkImportModal").classList.add("hidden");
}

async function submitBulkImport(event) {
  event.preventDefault();
  if (!state.user?.token) return alert("请先登录账号。");
  const bankName = byId("bulkBankName").value.trim();
  if (!bankName) return alert("请填写新增题库名称，避免和原有分类混淆。");
  const parsed = previewBulkImport();
  const existing = existingQuestionKeySet();
  const seen = new Set();
  const questions = parsed.questions.filter(q => {
    const key = duplicateQuestionKey(q);
    if (existing.has(key) || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  if (!questions.length) return alert("没有可导入的新题。");
  try {
    byId("submitBulkBtn").disabled = true;
    const bankData = await apiRequest(API.questions, {
      method: "POST",
      body: JSON.stringify({ action: "createBank", name: bankName })
    });
    const bank = bankData.bank;
    const data = await apiRequest(API.questions, {
      method: "POST",
      body: JSON.stringify({
        action: "bulkImport",
        questions: questions.map(q => ({ ...q, bankId: bank.id, bankName: bank.name, source: `用户新增题库：${bank.name}` }))
      })
    });
    byId("bulkPreview").innerHTML = `<div class="result-ok">已导入 ${data.imported?.length || 0} 道，跳过 ${data.skipped?.length || 0} 道重复题。</div>`;
    await syncCloudQuestions();
  } catch (error) {
    alert(error.message);
  } finally {
    byId("submitBulkBtn").disabled = false;
  }
}

function manageableBanks() {
  const banks = Object.values(state.cloud.banks || {});
  if (state.user?.isAdmin) return banks;
  return banks.filter(bank => bank.createdBy === state.user?.username);
}

function fillBankSelect(selected = "") {
  const banks = manageableBanks();
  byId("questionBank").innerHTML = [
    `<option value="">不归入用户题库</option>`,
    ...banks.map(bank => `<option value="${escapeHtml(bank.id)}">${escapeHtml(bank.name)}${bank.createdBy ? ` · ${escapeHtml(bank.createdBy)}` : ""}</option>`)
  ].join("");
  byId("questionBank").value = banks.some(bank => bank.id === selected) ? selected : "";
}

function openQuestionForm(question = null) {
  if (!state.user?.token) {
    alert("请先登录账号。");
    return;
  }
  byId("questionForm").reset();
  byId("editQuestionId").value = question?.id || "";
  byId("questionFormTitle").textContent = question ? "编辑题目" : "新增题目";
  byId("questionType").value = question?.type || "single";
  byId("questionChapter").value = question?.chapter || "";
  byId("questionSource").value = questionSource(question || {}) === "综合题库" ? "" : questionSource(question || {});
  fillBankSelect(question?.bankId || "");
  byId("questionAnswer").value = (question?.answer || []).join("");
  byId("questionPage").value = question?.page || "";
  byId("questionStem").value = question?.stem || "";
  byId("questionOptions").value = (question?.options || ["", "", "", ""]).join("\n");
  byId("questionAnalysis").value = question?.analysis || "";
  byId("questionOptionAnalysis").value = optionAnalysisToText(question?.optionAnalysis);
  byId("questionModal").classList.remove("hidden");
  refreshIcons();
}

function closeQuestionForm() {
  byId("questionModal").classList.add("hidden");
}

function questionFromForm(existing = null) {
  const type = byId("questionType").value;
  const options = byId("questionOptions").value
    .split(/\n+/)
    .map(line => line.trim().replace(/^[A-E][.．、]\s*/i, ""))
    .filter(Boolean);
  const answer = parseAnswerLetters(byId("questionAnswer").value);
  const bankId = byId("questionBank").value;
  const bank = bankById(bankId);
  const source = bank ? `用户题库：${bank.name}` : (byId("questionSource").value.trim() || existing?.source || "用户补充题库");
  return {
    type,
    chapter: byId("questionChapter").value.trim() || "用户题库",
    stem: byId("questionStem").value.trim(),
    options: type === "judge" && options.length < 2 ? ["正确", "错误"] : options,
    answer,
    page: byId("questionPage").value.trim(),
    analysis: byId("questionAnalysis").value.trim(),
    optionAnalysis: parseOptionAnalysis(byId("questionOptionAnalysis").value),
    source,
    bankId,
    bankName: bank?.name || ""
  };
}

async function submitQuestionForm(event) {
  event.preventDefault();
  if (!state.user?.token) return alert("请先登录账号。");
  const id = byId("editQuestionId").value;
  const existing = id ? questionById(id) : null;
  const payload = questionFromForm(existing);
  const maxAnswerIndex = Math.max(...payload.answer.map(letter => letter.charCodeAt(0) - 65), -1);
  if (!payload.stem) return alert("题干不能为空。");
  if (payload.options.length < 2) return alert("至少需要 2 个选项。");
  if (!payload.answer.length || maxAnswerIndex >= payload.options.length) return alert("答案字母需要对应已有选项。");
  if (payload.type === "single" && payload.answer.length !== 1) return alert("单选题只能有 1 个正确答案。");
  if (!id && existingQuestionKeySet().has(duplicateQuestionKey(payload))) return alert("题库中已存在相同题目，已停止新增。");
  try {
    byId("saveQuestionBtn").disabled = true;
    if (id) {
      await apiRequest(API.questions, {
        method: "PUT",
        body: JSON.stringify({ id, patch: payload })
      });
    } else {
      await apiRequest(API.questions, {
        method: "POST",
        body: JSON.stringify({ question: payload })
      });
    }
    await syncCloudQuestions();
    closeQuestionForm();
  } catch (error) {
    alert(error.message);
  } finally {
    byId("saveQuestionBtn").disabled = false;
  }
}

async function createBank() {
  if (!state.user?.token) return alert("请先登录账号。");
  const name = byId("newBankName").value.trim();
  if (!name) return alert("请输入题库名称。");
  try {
    await apiRequest(API.questions, {
      method: "POST",
      body: JSON.stringify({ action: "createBank", name })
    });
    byId("newBankName").value = "";
    await syncCloudQuestions();
    renderManage();
  } catch (error) {
    alert(error.message);
  }
}

async function updateBank(bankId) {
  const bank = bankById(bankId);
  if (!bank) return;
  const name = prompt("修改题库名称", bank.name);
  if (!name || name.trim() === bank.name) return;
  try {
    await apiRequest(API.questions, {
      method: "PUT",
      body: JSON.stringify({ action: "updateBank", bankId, name: name.trim() })
    });
    await syncCloudQuestions();
    renderManage();
  } catch (error) {
    alert(error.message);
  }
}

async function deleteBank(bankId) {
  const bank = bankById(bankId);
  if (!bank) return;
  const count = BANK.filter(q => q.bankId === bank.id).length;
  if (!confirm(`确定删除题库“${bank.name}”吗？其中 ${count} 道题也会从题库中隐藏。`)) return;
  try {
    await apiRequest(API.questions, {
      method: "DELETE",
      body: JSON.stringify({ action: "deleteBank", bankId })
    });
    await syncCloudQuestions();
    renderManage();
  } catch (error) {
    alert(error.message);
  }
}

async function deleteQuestion(id) {
  const q = questionById(id);
  if (!q) return;
  if (!confirm(`确定删除题目 ${id} 吗？删除后会从题库中隐藏。`)) return;
  try {
    await apiRequest(API.questions, {
      method: "DELETE",
      body: JSON.stringify({ id })
    });
    await syncCloudQuestions();
  } catch (error) {
    alert(error.message);
  }
}

function aiReviewPayload(question) {
  return {
    id: question.id,
    type: question.type,
    stem: question.stem,
    options: question.options,
    answer: question.answer
  };
}

function aiReviewCandidates(force = false) {
  return BANK
    .filter(q => force || !q.aiCheckedAt)
    .sort(compareQuestionId);
}

function renderAiPanelStatus(extra = "") {
  const total = BANK.length;
  const reviewed = BANK.filter(q => q.aiCheckedAt).length;
  const disputed = BANK.filter(q => q.disputed).length;
  const left = Math.max(0, total - reviewed);
  byId("aiReviewStatus").textContent = `${extra ? `${extra} ` : ""}已 AI 更新 ${reviewed}/${total} 题，剩余 ${left} 题，争议 ${disputed} 题。`;
}

async function runAiReviewBatch(force = false) {
  if (!state.user?.isAdmin) return alert("只有管理员可以使用 AI 解析更新。");
  const size = Math.max(1, Math.min(2, Number(byId("aiBatchSize").value || 2)));
  const questions = aiReviewCandidates(force).slice(0, size);
  if (!questions.length) {
    renderAiPanelStatus("没有待更新题目。");
    return;
  }
  const btns = [byId("aiReviewNextBtn"), byId("aiReviewForceBtn")];
  btns.forEach(btn => { btn.disabled = true; });
  renderAiPanelStatus(`正在更新 ${questions.map(q => q.id).join("、")}...`);
  try {
    const data = await apiRequest(API.aiReview, {
      method: "POST",
      body: JSON.stringify({ questions: questions.map(aiReviewPayload) })
    });
    await syncCloudQuestions();
    renderAiPanelStatus(`本批成功 ${data.success || 0} 题，争议 ${data.disputed || 0} 题。`);
  } catch (error) {
    renderAiPanelStatus(`更新失败：${error.message}`);
    alert(error.message);
  } finally {
    btns.forEach(btn => { btn.disabled = false; });
  }
}

async function loadAdminData() {
  if (!state.user?.isAdmin) return;
  try {
    const params = new URLSearchParams({
      auditPage: String(state.adminAuditPage || 1),
      auditPageSize: String(ADMIN_AUDIT_PAGE_SIZE)
    });
    const data = await apiRequest(`${API.admin}?${params}`, { method: "GET" });
    state.adminAuditPage = data.auditPage || state.adminAuditPage || 1;
    state.adminData = {
      users: data.users || [],
      audit: data.audit || [],
      auditPage: data.auditPage || state.adminAuditPage || 1,
      auditPageSize: data.auditPageSize || ADMIN_AUDIT_PAGE_SIZE,
      auditTotal: data.auditTotal || (data.audit || []).length,
      auditTotalPages: data.auditTotalPages || 1
    };
  } catch (error) {
    alert(error.message);
  }
}

async function createAccount() {
  const username = byId("newAccountName").value.trim();
  const password = byId("newAccountPassword").value;
  if (!username || !password) return alert("请输入账号和初始密码。");
  try {
    await apiRequest(API.admin, {
      method: "POST",
      body: JSON.stringify({ action: "createUser", username, password })
    });
    byId("newAccountName").value = "";
    byId("newAccountPassword").value = "";
    state.adminAuditPage = 1;
    await loadAdminData();
    renderManage();
  } catch (error) {
    alert(error.message);
  }
}

async function deleteAccount(username) {
  if (!confirm(`确定删除账号 ${username} 吗？该账号的云端进度也会删除。`)) return;
  try {
    await apiRequest(API.admin, {
      method: "POST",
      body: JSON.stringify({ action: "deleteUser", username })
    });
    state.adminAuditPage = 1;
    await loadAdminData();
    renderManage();
  } catch (error) {
    alert(error.message);
  }
}

async function setAccountAdmin(username, enabled) {
  const actionText = enabled ? "设为管理员" : "取消管理员权限";
  if (!confirm(`确定将账号 ${username} ${actionText}吗？`)) return;
  try {
    await apiRequest(API.admin, {
      method: "POST",
      body: JSON.stringify({ action: "setAdmin", username, isAdmin: enabled })
    });
    state.adminAuditPage = 1;
    await loadAdminData();
    renderManage();
  } catch (error) {
    alert(error.message);
  }
}

async function resetAccountPassword(username) {
  const password = prompt(`请输入账号 ${username} 的新密码（至少 6 位）`);
  if (!password) return;
  if (password.length < 6) return alert("新密码至少需要 6 位。");
  if (!confirm(`确定重置账号 ${username} 的密码吗？`)) return;
  try {
    await apiRequest(API.admin, {
      method: "POST",
      body: JSON.stringify({ action: "resetPassword", username, password })
    });
    state.adminAuditPage = 1;
    await loadAdminData();
    renderManage();
    alert(`账号 ${username} 的密码已重置。`);
  } catch (error) {
    alert(error.message);
  }
}

async function changeOwnPassword() {
  if (!state.user?.token) return alert("请先登录账号。");
  const currentPassword = byId("ownCurrentPassword").value;
  const newPassword = byId("ownNewPassword").value;
  if (!currentPassword || !newPassword) return alert("请输入当前密码和新密码。");
  if (newPassword.length < 6) return alert("新密码至少需要 6 位。");
  try {
    byId("changeOwnPasswordBtn").disabled = true;
    await apiRequest(API.auth, {
      method: "POST",
      body: JSON.stringify({ action: "changePassword", currentPassword, newPassword })
    });
    byId("ownCurrentPassword").value = "";
    byId("ownNewPassword").value = "";
    alert("密码已修改，请使用新密码登录。");
  } catch (error) {
    alert(error.message);
  } finally {
    byId("changeOwnPasswordBtn").disabled = false;
  }
}

function changeAdminUsersPage(direction) {
  const users = state.adminData.users || [];
  const totalPages = Math.max(1, Math.ceil(users.length / ADMIN_USERS_PAGE_SIZE));
  state.adminUsersPage = pageFromDirection(state.adminUsersPage || 1, totalPages, direction);
  renderManage();
}

async function changeAdminAuditPage(direction) {
  const totalPages = Math.max(1, state.adminData.auditTotalPages || 1);
  state.adminAuditPage = pageFromDirection(state.adminAuditPage || 1, totalPages, direction);
  await loadAdminData();
  renderManage();
}

async function loadDiscussion() {
  try {
    const data = await apiRequest(API.discussion, { method: "GET" });
    state.discussion = Array.isArray(data.posts) ? data.posts : [];
  } catch {
    state.discussion = [];
  }
}

async function postDiscussion() {
  if (!state.user?.token) return alert("请先登录账号。");
  const input = byId("discussionInput");
  const message = input.value.trim();
  if (!message) return alert("请输入发言内容。");
  try {
    byId("postDiscussionBtn").disabled = true;
    await apiRequest(API.discussion, {
      method: "POST",
      body: JSON.stringify({ message })
    });
    input.value = "";
    await loadDiscussion();
    renderDiscussion();
  } catch (error) {
    alert(error.message);
  } finally {
    byId("postDiscussionBtn").disabled = !state.user?.token;
  }
}

async function deleteDiscussion(id) {
  if (!state.user?.token) return alert("请先登录账号。");
  if (!confirm("确定删除这条发言吗？")) return;
  try {
    await apiRequest(API.discussion, {
      method: "DELETE",
      body: JSON.stringify({ id })
    });
    await loadDiscussion();
    renderDiscussion();
  } catch (error) {
    alert(error.message);
  }
}

async function postReply(postId) {
  if (!state.user?.token) return alert("请先登录账号。");
  const input = byId(`reply_${postId}`);
  const message = input?.value.trim();
  if (!message) return alert("请输入回复内容。");
  try {
    await apiRequest(API.discussion, {
      method: "POST",
      body: JSON.stringify({ action: "reply", postId, message })
    });
    await loadDiscussion();
    renderDiscussion();
  } catch (error) {
    alert(error.message);
  }
}

async function deleteReply(postId, replyId) {
  if (!state.user?.token) return alert("请先登录账号。");
  if (!confirm("确定删除这条回复吗？")) return;
  try {
    await apiRequest(API.discussion, {
      method: "DELETE",
      body: JSON.stringify({ id: postId, replyId })
    });
    await loadDiscussion();
    renderDiscussion();
  } catch (error) {
    alert(error.message);
  }
}

function toggleReplies(postId) {
  state.collapsedReplies[postId] = !state.collapsedReplies[postId];
  renderDiscussion();
}

async function togglePinPost(postId, pinned) {
  if (!state.user?.isAdmin) return alert("只有管理员可以置顶帖子。");
  try {
    await apiRequest(API.discussion, {
      method: "POST",
      body: JSON.stringify({ action: "pin", id: postId, pinned })
    });
    await loadDiscussion();
    renderDiscussion();
  } catch (error) {
    alert(error.message);
  }
}

function renderDiscussion() {
  byId("postDiscussionBtn").disabled = !state.user?.token;
  byId("discussionHint").textContent = state.user?.token ? `以 ${state.user.username} 身份发言。` : "注册或登录后可发言。";
  if (!state.discussion.length) {
    byId("discussionList").innerHTML = `<div class="empty">讨论区还没有发言。</div>`;
    return;
  }
  byId("discussionList").innerHTML = state.discussion.map(post => {
    const canDeletePost = state.user?.isAdmin || (state.user?.username && post.author === state.user.username);
    const replies = (post.replies || []).filter(reply => !reply.deletedAt);
    const repliesCollapsed = Boolean(state.collapsedReplies[post.id]);
    return `
    <div class="discussion-post">
      <div class="discussion-post-head">
        <div>
          <strong>${escapeHtml(post.author || "--")}</strong>
          ${post.pinned ? `<span class="badge pinned">置顶</span>` : ""}
          <div class="meta-line">${escapeHtml(post.createdAt || "")}</div>
        </div>
        <div class="discussion-post-actions">
          <button class="soft-btn" data-action="toggle-replies" data-id="${escapeHtml(post.id)}"><i data-lucide="${repliesCollapsed ? "chevron-down" : "chevron-up"}"></i><span>${repliesCollapsed ? "展开回复" : "折叠回复"}${replies.length ? `(${replies.length})` : ""}</span></button>
          ${state.user?.isAdmin ? `<button class="soft-btn" data-action="pin-discussion" data-id="${escapeHtml(post.id)}" data-pin="${post.pinned ? "false" : "true"}"><i data-lucide="pin"></i><span>${post.pinned ? "取消置顶" : "置顶"}</span></button>` : ""}
          ${canDeletePost ? `<button class="soft-btn" data-action="delete-discussion" data-id="${escapeHtml(post.id)}"><i data-lucide="trash-2"></i><span>删除</span></button>` : ""}
        </div>
      </div>
      <div class="discussion-message">${escapeHtml(post.message || "")}</div>
      ${repliesCollapsed ? "" : `
      <div class="reply-area">
        <div class="reply-list">
        ${replies.map(reply => {
          const canDeleteReply = state.user?.isAdmin || (state.user?.username && reply.author === state.user.username);
          return `
          <div class="reply-item">
            <div><strong>${escapeHtml(reply.author || "--")}</strong><span class="meta-line"> · ${escapeHtml(reply.createdAt || "")}</span></div>
            <div class="discussion-message">${escapeHtml(reply.message || "")}</div>
            ${canDeleteReply ? `<button class="soft-btn" data-action="delete-reply" data-post="${escapeHtml(post.id)}" data-reply="${escapeHtml(reply.id)}"><i data-lucide="trash-2"></i><span>删除回复</span></button>` : ""}
          </div>
        `;
        }).join("")}
        </div>
        <div class="reply-compose">
          <input id="reply_${escapeHtml(post.id)}" type="text" placeholder="${state.user?.token ? "回复这个帖子" : "登录后可回复"}" ${state.user?.token ? "" : "disabled"}>
          <button class="soft-btn" data-action="post-reply" data-id="${escapeHtml(post.id)}" ${state.user?.token ? "" : "disabled"}><i data-lucide="message-circle"></i><span>回复</span></button>
        </div>
      </div>
      `}
    </div>
  `;
  }).join("");
  refreshIcons();
}

function initTimelineFilters(preserve = false) {
  const kindFilter = byId("timelineKindFilter");
  const actorFilter = byId("timelineActorFilter");
  const currentKind = preserve ? kindFilter.value : "all";
  const currentActor = preserve ? actorFilter.value : "all";
  const kinds = ["all", ...new Set(TIMELINE_DATA.map(item => item.kind).filter(Boolean))];
  const actors = ["all", ...new Set(TIMELINE_DATA.map(item => item.actor).filter(Boolean))];
  kindFilter.innerHTML = kinds.map(kind => {
    const label = kind === "all" ? "全部类型" : kind;
    return `<option value="${escapeHtml(kind)}">${escapeHtml(label)}</option>`;
  }).join("");
  actorFilter.innerHTML = actors.map(actor => {
    const label = actor === "all" ? "全部人物/主体" : actor;
    return `<option value="${escapeHtml(actor)}">${escapeHtml(label)}</option>`;
  }).join("");
  kindFilter.value = kinds.includes(currentKind) ? currentKind : "all";
  actorFilter.value = actors.includes(currentActor) ? currentActor : "all";
}

function filteredTimeline() {
  const kind = byId("timelineKindFilter").value;
  const actor = byId("timelineActorFilter").value;
  const search = byId("timelineSearch").value.trim();
  return [...TIMELINE_DATA].sort((a, b) => timelineOrderValue(a) - timelineOrderValue(b) || String(a.time).localeCompare(String(b.time), "zh-Hans-CN")).filter(item => {
    if (kind !== "all" && item.kind !== kind) return false;
    if (actor !== "all" && item.actor !== actor) return false;
    if (search) {
      const blob = `${item.time} ${item.actor} ${item.name} ${item.kind} ${item.significance} ${item.chapter} ${item.page}`;
      if (!blob.includes(search)) return false;
    }
    return true;
  });
}

function renderTimeline() {
  const items = filteredTimeline();
  byId("timelineCount").textContent = `${items.length} / ${TIMELINE_DATA.length} 条`;
  if (!items.length) {
    byId("timelineCards").innerHTML = `<div class="empty">没有匹配的会议或文献。</div>`;
    byId("timelineTableBody").innerHTML = "";
    return;
  }
  byId("timelineCards").innerHTML = items.map((item, index) => `
    <article class="timeline-item">
      <div class="timeline-marker"></div>
      <div class="timeline-card">
        <div class="timeline-card-head">
          <strong>${escapeHtml(item.time)}</strong>
          <span class="badge">${escapeHtml(item.kind || "条目")}</span>
        </div>
        <h3>${escapeHtml(item.name)}</h3>
        <div class="meta-line">${escapeHtml(item.actor || "--")} · ${escapeHtml(item.chapter || "--")}</div>
        <p>${escapeHtml(item.significance || "")}</p>
        <div class="timeline-card-foot">
          <span>课本页码：${escapeHtml(item.page || "--")}</span>
          <span>#${escapeHtml(item.id || "")}</span>
        </div>
        ${state.user?.token ? `
          <div class="content-actions">
            <button class="soft-btn" data-action="move-timeline" data-id="${escapeHtml(item.id)}" data-dir="up" ${index <= 0 ? "disabled" : ""}><i data-lucide="arrow-up"></i><span>上移</span></button>
            <button class="soft-btn" data-action="move-timeline" data-id="${escapeHtml(item.id)}" data-dir="down" ${index >= items.length - 1 ? "disabled" : ""}><i data-lucide="arrow-down"></i><span>下移</span></button>
            <button class="soft-btn" data-action="edit-content" data-type="timeline" data-id="${escapeHtml(item.id)}"><i data-lucide="pencil"></i><span>编辑</span></button>
          </div>
        ` : ""}
      </div>
    </article>
  `).join("");
  byId("timelineTableBody").innerHTML = items.map(item => `
    <tr>
      <td>${escapeHtml(item.time)}</td>
      <td>${escapeHtml(item.actor || "--")}</td>
      <td><strong>${escapeHtml(item.name)}</strong><div class="meta-line">${escapeHtml(item.kind || "")} · ${escapeHtml(item.chapter || "")}</div></td>
      <td>${escapeHtml(item.significance || "")}</td>
      <td>${escapeHtml(item.page || "--")}</td>
    </tr>
  `).join("");
  refreshIcons();
}

function initKeypointFilters(preserve = false) {
  const chapterFilter = byId("keypointChapterFilter");
  const levelFilter = byId("keypointLevelFilter");
  const currentChapter = preserve ? chapterFilter.value : "all";
  const currentLevel = preserve ? levelFilter.value : "all";
  const chapters = ["all", ...new Set(KEYPOINTS_DATA.map(item => item.chapter).filter(Boolean))];
  const levels = ["all", ...new Set(KEYPOINTS_DATA.map(item => item.level).filter(Boolean))];
  chapterFilter.innerHTML = chapters.map(chapter => `<option value="${escapeHtml(chapter)}">${escapeHtml(chapter === "all" ? "全部章节" : chapter)}</option>`).join("");
  levelFilter.innerHTML = levels.map(level => `<option value="${escapeHtml(level)}">${escapeHtml(level === "all" ? "全部类型" : level)}</option>`).join("");
  chapterFilter.value = chapters.includes(currentChapter) ? currentChapter : "all";
  levelFilter.value = levels.includes(currentLevel) ? currentLevel : "all";
}

function filteredKeypoints() {
  const chapter = byId("keypointChapterFilter").value;
  const level = byId("keypointLevelFilter").value;
  const search = byId("keypointSearch").value.trim();
  return [...KEYPOINTS_DATA].filter(item => {
    if (chapter !== "all" && item.chapter !== chapter) return false;
    if (level !== "all" && item.level !== level) return false;
    if (search) {
      const blob = `${item.chapter} ${item.module} ${item.keyword} ${item.content} ${item.page} ${item.level}`;
      if (!blob.includes(search)) return false;
    }
    return true;
  });
}

function renderKeypoints() {
  const items = filteredKeypoints();
  byId("keypointCount").textContent = `${items.length} / ${KEYPOINTS_DATA.length} 条`;
  if (!items.length) {
    byId("keypointsList").innerHTML = `<div class="empty">没有匹配的章节重点。</div>`;
    return;
  }
  const groups = new Map();
  items.forEach(item => {
    if (!groups.has(item.chapter)) groups.set(item.chapter, []);
    groups.get(item.chapter).push(item);
  });
  byId("keypointsList").innerHTML = [...groups.entries()].map(([chapter, rows]) => `
    <section class="keypoint-section">
      <div class="keypoint-section-head">
        <h3>${escapeHtml(chapter)}</h3>
        <span class="badge">${escapeHtml(rows[0]?.chapterPages || "")}</span>
      </div>
      <div class="keypoint-grid">
        ${rows.map(item => `
          <article class="keypoint-card">
            <div class="keypoint-card-head">
              <span class="badge ${item.level === "高频" ? "multi" : item.level === "理解" ? "chapter" : ""}">${escapeHtml(item.level || "识记")}</span>
              <span class="meta-line">页码：${escapeHtml(item.page || "--")} · #${escapeHtml(item.id)}</span>
            </div>
            <h4>${escapeHtml(item.module)}：${escapeHtml(item.keyword)}</h4>
            <p>${escapeHtml(item.content)}</p>
            ${state.user?.token ? `<div class="content-actions"><button class="soft-btn" data-action="edit-content" data-type="keypoint" data-id="${escapeHtml(item.id)}"><i data-lucide="pencil"></i><span>编辑</span></button></div>` : ""}
          </article>
        `).join("")}
      </div>
    </section>
  `).join("");
  refreshIcons();
}

function findContentItem(type, id) {
  const items = type === "timeline" ? TIMELINE_DATA : KEYPOINTS_DATA;
  return items.find(item => item.id === id) || null;
}

function openContentForm(type, item = null) {
  if (!state.user?.token) {
    alert("请先登录账号。");
    return;
  }
  byId("contentForm").reset();
  byId("contentType").value = type;
  byId("contentId").value = item?.id || "";
  byId("contentFormTitle").textContent = item ? "编辑内容" : (type === "timeline" ? "新增时间线条目" : "新增章节重点");
  byId("timelineContentFields").classList.toggle("hidden", type !== "timeline");
  byId("keypointContentFields").classList.toggle("hidden", type !== "keypoint");
  byId("deleteContentBtn").classList.toggle("hidden", !item || !state.user?.token);
  if (type === "timeline") {
    byId("contentTime").value = item?.time || "";
    byId("contentActor").value = item?.actor || "";
    byId("contentKind").value = item?.kind || "文献/报告";
    byId("contentPage").value = item?.page || "";
    byId("contentName").value = item?.name || "";
    byId("contentSignificance").value = item?.significance || "";
    byId("contentChapter").value = item?.chapter || "";
    byId("contentChapterPages").value = item?.chapterPages || "";
  } else {
    byId("kpChapter").value = item?.chapter || "";
    byId("kpChapterPages").value = item?.chapterPages || "";
    byId("kpModule").value = item?.module || "";
    byId("kpKeyword").value = item?.keyword || "";
    byId("kpLevel").value = item?.level || "识记";
    byId("kpPage").value = item?.page || "";
    byId("kpContent").value = item?.content || "";
  }
  byId("contentModal").classList.remove("hidden");
  refreshIcons();
}

function closeContentForm() {
  byId("contentModal").classList.add("hidden");
}

function contentPayloadFromForm() {
  const type = byId("contentType").value;
  if (type === "timeline") {
    return {
      time: byId("contentTime").value.trim(),
      actor: byId("contentActor").value.trim(),
      kind: byId("contentKind").value.trim() || "文献/报告",
      page: byId("contentPage").value.trim(),
      name: byId("contentName").value.trim(),
      significance: byId("contentSignificance").value.trim(),
      chapter: byId("contentChapter").value.trim(),
      chapterPages: byId("contentChapterPages").value.trim()
    };
  }
  return {
    chapter: byId("kpChapter").value.trim(),
    chapterPages: byId("kpChapterPages").value.trim(),
    module: byId("kpModule").value.trim(),
    keyword: byId("kpKeyword").value.trim(),
    level: byId("kpLevel").value.trim() || "识记",
    page: byId("kpPage").value.trim(),
    content: byId("kpContent").value.trim()
  };
}

function timelineOrderPayload(item, order) {
  return {
    time: item.time || "",
    actor: item.actor || "",
    kind: item.kind || "文献/报告",
    page: item.page || "",
    name: item.name || "",
    significance: item.significance || "",
    chapter: item.chapter || "",
    chapterPages: item.chapterPages || "",
    order
  };
}

async function updateTimelineOrder(item, order) {
  return apiRequest(API.content, {
    method: "PUT",
    body: JSON.stringify({ type: "timeline", id: item.id, patch: timelineOrderPayload(item, order) })
  });
}

async function moveTimelineItem(id, direction) {
  if (!state.user?.token) return alert("请先登录账号。");
  const items = filteredTimeline();
  const index = items.findIndex(item => item.id === id);
  if (index < 0) return;
  const targetIndex = direction === "up" ? index - 1 : index + 1;
  if (targetIndex < 0 || targetIndex >= items.length) return;
  const current = items[index];
  const target = items[targetIndex];
  const currentOrder = timelineOrderValue(current);
  const targetOrder = timelineOrderValue(target);
  try {
    await updateTimelineOrder(current, targetOrder);
    await updateTimelineOrder(target, currentOrder);
    await syncContentCloud();
  } catch (error) {
    alert(error.message);
  }
}

async function submitContentForm(event) {
  event.preventDefault();
  const type = byId("contentType").value;
  const id = byId("contentId").value;
  try {
    if (id) {
      await apiRequest(API.content, {
        method: "PUT",
        body: JSON.stringify({ type, id, patch: contentPayloadFromForm() })
      });
    } else {
      await apiRequest(API.content, {
        method: "POST",
        body: JSON.stringify({ type, item: contentPayloadFromForm() })
      });
    }
    closeContentForm();
    await syncContentCloud();
  } catch (error) {
    alert(error.message);
  }
}

async function deleteContentItem() {
  if (!state.user?.token) return alert("请先登录账号。");
  const type = byId("contentType").value;
  const id = byId("contentId").value;
  if (!id || !confirm("确定删除这条内容吗？")) return;
  try {
    await apiRequest(API.content, {
      method: "DELETE",
      body: JSON.stringify({ type, id })
    });
    closeContentForm();
    await syncContentCloud();
  } catch (error) {
    alert(error.message);
  }
}

function renderManage() {
  if (!state.user?.token) {
    byId("bankList").innerHTML = `<div class="empty">登录后可以创建自己的题库。</div>`;
    return;
  }
  const banks = Object.values(state.cloud.banks || {});
  const visibleBanks = state.user.isAdmin ? banks : banks.filter(bank => bank.createdBy === state.user.username);
  byId("bankList").innerHTML = visibleBanks.length ? visibleBanks.map(bank => {
    const count = BANK.filter(q => q.bankId === bank.id).length;
    const canManage = state.user.isAdmin || bank.createdBy === state.user.username;
    return `
      <div class="manage-row">
        <div class="manage-row-head">
          <strong>${escapeHtml(bank.name)}</strong>
          <span class="badge">${count} 题</span>
        </div>
        <div class="meta-line">创建者：${escapeHtml(bank.createdBy || "--")} · ${escapeHtml(bank.createdAt || "")}</div>
        <div class="manage-row-actions">
          ${canManage ? `<button class="soft-btn" data-action="rename-bank" data-id="${escapeHtml(bank.id)}"><i data-lucide="pencil"></i><span>改名</span></button>` : ""}
          ${canManage ? `<button class="soft-btn" data-action="delete-bank" data-id="${escapeHtml(bank.id)}"><i data-lucide="trash-2"></i><span>删除题库</span></button>` : ""}
          <button class="soft-btn" data-action="filter-bank" data-source="${escapeHtml(`用户题库：${bank.name}`)}"><i data-lucide="search"></i><span>筛选</span></button>
        </div>
      </div>
    `;
  }).join("") : `<div class="empty">还没有创建题库。</div>`;

  byId("adminAccountsPanel").classList.toggle("hidden", !state.user.isAdmin);
  byId("adminAiPanel").classList.toggle("hidden", !state.user.isAdmin);
  byId("adminAuditPanel").classList.toggle("hidden", !state.user.isAdmin);
  if (state.user.isAdmin) {
    renderAiPanelStatus();
    const users = state.adminData.users || [];
    const userTotalPages = Math.max(1, Math.ceil(users.length / ADMIN_USERS_PAGE_SIZE));
    state.adminUsersPage = Math.min(Math.max(1, state.adminUsersPage || 1), userTotalPages);
    const userStart = (state.adminUsersPage - 1) * ADMIN_USERS_PAGE_SIZE;
    const pageUsers = users.slice(userStart, userStart + ADMIN_USERS_PAGE_SIZE);
    byId("accountList").innerHTML = pageUsers.map(user => `
      <div class="manage-row">
        <div class="manage-row-head">
          <strong>${escapeHtml(user.username)}</strong>
          <div class="manage-row-actions">
            ${user.isAdmin ? `<span class="badge">${user.isEnvAdmin ? "保留管理员" : "管理员"}</span>` : ""}
            ${user.username === state.user.username ? `<span class="badge chapter">当前账号</span>` : ""}
            <button class="soft-btn" data-action="reset-password" data-user="${escapeHtml(user.username)}"><i data-lucide="key-round"></i><span>重置密码</span></button>
            ${!user.isEnvAdmin && user.username !== state.user.username ? `<button class="soft-btn" data-action="toggle-admin" data-user="${escapeHtml(user.username)}" data-admin="${user.isAdmin ? "false" : "true"}"><i data-lucide="${user.isAdmin ? "shield-minus" : "shield-plus"}"></i><span>${user.isAdmin ? "取消管理员" : "设为管理员"}</span></button>` : ""}
            ${!user.isAdmin && user.username !== state.user.username ? `<button class="soft-btn" data-action="delete-account" data-user="${escapeHtml(user.username)}"><i data-lucide="user-x"></i><span>删除</span></button>` : ""}
          </div>
        </div>
        <div class="meta-line">创建时间：${escapeHtml(user.createdAt || "--")}</div>
      </div>
    `).join("") || `<div class="empty">暂无账号。</div>`;
    byId("accountPager").innerHTML = users.length ? pagerHtml("admin-users-page", state.adminUsersPage, userTotalPages, `${users.length} 个账号`) : "";

    const audit = state.adminData.audit || [];
    const auditPage = state.adminData.auditPage || state.adminAuditPage || 1;
    const auditTotalPages = Math.max(1, state.adminData.auditTotalPages || 1);
    const auditTotal = Number(state.adminData.auditTotal || audit.length);
    state.adminAuditPage = Math.min(Math.max(1, auditPage), auditTotalPages);
    byId("auditList").innerHTML = audit.map(item => `
      <div class="audit-row">
        <div><strong>${escapeHtml(item.actor || "--")}</strong><div class="meta-line">${escapeHtml(item.at || "")}</div></div>
        <div>${escapeHtml(item.action || "")}<div class="meta-line">${escapeHtml(item.summary || "")}</div></div>
        <pre class="audit-detail">${escapeHtml(JSON.stringify(item.detail || {}, null, 2))}</pre>
      </div>
    `).join("") || `<div class="empty">暂无记录。</div>`;
    byId("auditPager").innerHTML = auditTotal ? pagerHtml("admin-audit-page", state.adminAuditPage, auditTotalPages, `${auditTotal} 条记录`) : "";
  }
  refreshIcons();
}

function refreshCurrentView() {
  if (state.view === "practice") renderPractice();
  if (state.view === "wrong") renderWrong();
  if (state.view === "studied") renderStudied();
  if (state.view === "favorites") renderFavorites();
  if (state.view === "browse") renderBrowse();
  if (state.view === "timeline") renderTimeline();
  if (state.view === "keypoints") renderKeypoints();
  if (state.view === "discussion") renderDiscussion();
  if (state.view === "manage") renderManage();
  renderStats();
  renderAccountPanel();
}

function refreshIcons() {
  if (window.lucide) window.lucide.createIcons();
}

function toggleSidebar() {
  const shell = document.querySelector(".app-shell");
  const collapsed = shell.classList.toggle("sidebar-collapsed");
  byId("sidebarToggle").title = collapsed ? "展开功能区" : "折叠功能区";
  byId("sidebarToggle").innerHTML = `<i data-lucide="${collapsed ? "panel-left-open" : "panel-left-close"}"></i>`;
  refreshIcons();
}

function bindEvents() {
  document.querySelectorAll(".nav-btn").forEach(btn => {
    btn.addEventListener("click", () => setView(btn.dataset.view));
  });
  byId("sidebarToggle").addEventListener("click", toggleSidebar);
  const handleFilterChange = () => {
    state.browsePage = 1;
    refreshCurrentView();
  };
  byId("chapterFilter").addEventListener("change", handleFilterChange);
  byId("typeFilter").addEventListener("change", handleFilterChange);
  byId("sourceFilter").addEventListener("change", handleFilterChange);
  byId("statusFilter").addEventListener("change", handleFilterChange);
  byId("searchInput").addEventListener("input", handleFilterChange);
  byId("timelineKindFilter").addEventListener("change", renderTimeline);
  byId("timelineActorFilter").addEventListener("change", renderTimeline);
  byId("timelineSearch").addEventListener("input", renderTimeline);
  byId("timelineResetBtn").addEventListener("click", () => {
    byId("timelineKindFilter").value = "all";
    byId("timelineActorFilter").value = "all";
    byId("timelineSearch").value = "";
    renderTimeline();
  });
  byId("addTimelineBtn").addEventListener("click", () => openContentForm("timeline"));
  byId("keypointChapterFilter").addEventListener("change", renderKeypoints);
  byId("keypointLevelFilter").addEventListener("change", renderKeypoints);
  byId("keypointSearch").addEventListener("input", renderKeypoints);
  byId("keypointResetBtn").addEventListener("click", () => {
    byId("keypointChapterFilter").value = "all";
    byId("keypointLevelFilter").value = "all";
    byId("keypointSearch").value = "";
    renderKeypoints();
  });
  byId("addKeypointBtn").addEventListener("click", () => openContentForm("keypoint"));
  byId("shuffleBtn").addEventListener("click", () => renderPractice());
  byId("resetFiltersBtn").addEventListener("click", () => {
    resetQuestionFilters();
    state.wrongOnly = false;
    state.browsePage = 1;
    refreshCurrentView();
  });
  byId("reviewWrongBtn").addEventListener("click", () => {
    state.wrongOnly = !state.wrongOnly;
    byId("reviewWrongBtn").classList.toggle("primary-btn", state.wrongOnly);
    setView("practice");
  });
  byId("resetMasteredBtn").addEventListener("click", resetMastered);
  byId("exportWrongBtn").addEventListener("click", exportWrong);
  byId("startExamBtn").addEventListener("click", startExam);
  byId("submitExamBtn").addEventListener("click", submitExam);
  byId("loginBtn").addEventListener("click", () => authenticate("login"));
  byId("registerBtn").addEventListener("click", () => authenticate("register"));
  byId("logoutBtn").addEventListener("click", logout);
  byId("syncBtn").addEventListener("click", async () => {
    await syncCloudQuestions();
    await syncContentCloud();
    await syncProgressAfterAuth();
  });
  byId("addQuestionBtn").addEventListener("click", () => openQuestionForm());
  byId("bulkImportBtn").addEventListener("click", openBulkImport);
  byId("previewBulkBtn").addEventListener("click", previewBulkImport);
  byId("bulkImportForm").addEventListener("submit", submitBulkImport);
  byId("createBankBtn").addEventListener("click", createBank);
  byId("changeOwnPasswordBtn").addEventListener("click", changeOwnPassword);
  byId("createAccountBtn").addEventListener("click", createAccount);
  byId("aiReviewNextBtn").addEventListener("click", () => runAiReviewBatch(false));
  byId("aiReviewForceBtn").addEventListener("click", () => runAiReviewBatch(true));
  byId("postDiscussionBtn").addEventListener("click", postDiscussion);
  byId("closeQuestionModal").addEventListener("click", closeQuestionForm);
  byId("questionForm").addEventListener("submit", submitQuestionForm);
  byId("contentForm").addEventListener("submit", submitContentForm);
  byId("deleteContentBtn").addEventListener("click", deleteContentItem);
  byId("clearWrongBtn").addEventListener("click", () => {
    if (confirm("确定清空错题本吗？")) {
      state.store.wrong = {};
      saveStore();
      renderWrong();
      renderStats();
    }
  });
  byId("wrongPracticeBtn").addEventListener("click", () => {
    resetQuestionFilters();
    state.wrongOnly = true;
    setView("practice");
  });
  document.addEventListener("click", event => {
    const action = event.target.closest("[data-action]");
    if (!action) return;
    const name = action.dataset.action;
    if (name === "submit-one") submitPractice();
    if (name === "prev") renderPreviousPractice();
    if (name === "next") renderPractice();
    if (name === "practice-this") {
      const q = questionById(action.dataset.id);
      if (q) {
        setView("practice");
        renderPractice(q);
      }
    }
    if (name === "toggle-favorite") toggleFavorite(action.dataset.id);
    if (name === "requeue-question") requeueQuestion(action.dataset.id);
    if (name === "remove-wrong") removeWrong(action.dataset.id);
    if (name === "edit-question") openQuestionForm(questionById(action.dataset.id));
    if (name === "delete-question") deleteQuestion(action.dataset.id);
    if (name === "browse-page") changeBrowsePage(action.dataset.page);
    if (name === "wrong-page") changeCollectionPage("wrongPage", renderWrong, action.dataset.page);
    if (name === "studied-page") changeCollectionPage("studiedPage", renderStudied, action.dataset.page);
    if (name === "favorites-page") changeCollectionPage("favoritesPage", renderFavorites, action.dataset.page);
    if (name === "admin-users-page") changeAdminUsersPage(action.dataset.page);
    if (name === "admin-audit-page") changeAdminAuditPage(action.dataset.page);
    if (name === "delete-discussion") deleteDiscussion(action.dataset.id);
    if (name === "toggle-replies") toggleReplies(action.dataset.id);
    if (name === "pin-discussion") togglePinPost(action.dataset.id, action.dataset.pin === "true");
    if (name === "post-reply") postReply(action.dataset.id);
    if (name === "delete-reply") deleteReply(action.dataset.post, action.dataset.reply);
    if (name === "move-timeline") moveTimelineItem(action.dataset.id, action.dataset.dir);
    if (name === "edit-content") openContentForm(action.dataset.type, findContentItem(action.dataset.type, action.dataset.id));
    if (name === "rename-bank") updateBank(action.dataset.id);
    if (name === "delete-bank") deleteBank(action.dataset.id);
    if (name === "toggle-admin") setAccountAdmin(action.dataset.user, action.dataset.admin === "true");
    if (name === "reset-password") resetAccountPassword(action.dataset.user);
    if (name === "delete-account") deleteAccount(action.dataset.user);
    if (name === "filter-bank") {
      byId("sourceFilter").value = action.dataset.source;
      state.browsePage = 1;
      setView("browse");
    }
    if (name === "close-question-form") closeQuestionForm();
    if (name === "close-bulk-import") closeBulkImport();
    if (name === "close-content-form") closeContentForm();
  });
}

async function init() {
  initFilters();
  initTimelineFilters();
  initKeypointFilters();
  bindEvents();
  await refreshAuthInfo();
  renderAccountPanel();
  renderStats();
  renderPractice();
  renderTimeline();
  refreshIcons();
  await syncCloudQuestions();
  await syncContentCloud();
  if (state.user?.token) {
    try {
      await syncProgressAfterAuth();
      if (state.user.isAdmin) await loadAdminData();
    } catch (error) {
      setCloudStatus("需重登", "error");
    }
  }
}

init();
