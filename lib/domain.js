// 状态判断模块（纯业务逻辑，不碰 HTTP 与文件）：
// 游丝定型 -> 合格放行 / 不合格返工 -> 换人复核 -> 连续两次温漂复测合格 -> 放行。
// 更换游丝或修订定型单会让原调校、复测与放行结论立即失效（标记 voided，旧版留档）。

// ---- 定型工艺常量 ----
const FURNACE_TEMP_MIN = 180; // 摄氏度，含端点
const FURNACE_TEMP_MAX = 220;
const SOAK_HOURS_MIN = 2;
const REQUIRED_DRIFT_PASSES = 2; // 返工后需连续两次温漂复测合格

// 定型单状态
// AWAITING_RELEASE   定型参数合格，待放行
// REWORK_REQUIRED    炉温/保温不达标，只能返工
// AWAITING_DRIFT     返工经换人复核合格，进入温漂复测
// RELEASED           已放行
// SUPERSEDED         被修订或换游丝作废，仅留档
const STATUS = {
  AWAITING_RELEASE: "awaiting_release",
  REWORK_REQUIRED: "rework_required",
  AWAITING_DRIFT: "awaiting_drift_retest",
  RELEASED: "released",
  SUPERSEDED: "superseded"
};
const OPEN_STATUSES = [
  STATUS.AWAITING_RELEASE,
  STATUS.REWORK_REQUIRED,
  STATUS.AWAITING_DRIFT
];

class HttpError extends Error {
  constructor(status, message, extra) {
    super(message);
    this.status = status;
    Object.assign(this, extra || {});
  }
}

function makeId(prefix) {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function required(body, fields) {
  const missing = fields.filter((field) => body[field] === undefined || body[field] === "");
  if (missing.length) throw new HttpError(400, `缺少字段：${missing.join(", ")}`);
}

function numberField(body, field, { integer = false, allowNaN = false } = {}) {
  const value = Number(body[field]);
  if (!allowNaN && !Number.isFinite(value)) {
    throw new HttpError(400, `字段 ${field} 必须是数字`);
  }
  if (integer && Number.isFinite(value) && !Number.isInteger(value)) {
    throw new HttpError(400, `字段 ${field} 必须是整数`);
  }
  return value;
}

// 定型参数是否合格：炉温 180-220℃（含）且保温不少于 2 小时。
function isShapeQualified(furnaceTempC, soakHours) {
  return (
    Number.isFinite(furnaceTempC) &&
    Number.isFinite(soakHours) &&
    furnaceTempC >= FURNACE_TEMP_MIN &&
    furnaceTempC <= FURNACE_TEMP_MAX &&
    soakHours >= SOAK_HOURS_MIN
  );
}

// ---- 档案查找 ----
function findClock(db, clockId) {
  const clock = db.clocks.find((item) => item.id === clockId);
  if (!clock) throw new HttpError(404, "钟表不存在");
  return clock;
}

function findOrder(db, orderId) {
  const order = db.shapeOrders.find((item) => item.id === orderId);
  if (!order) throw new HttpError(404, "定型单不存在");
  return order;
}

function ordersOf(db, clockId) {
  return db.shapeOrders
    .filter((item) => item.clockId === clockId)
    .sort((a, b) => b.version - a.version || new Date(b.createdAt) - new Date(a.createdAt));
}

// 当前定型单：版本号最高的一张（含已作废留档的最新版）。
function currentOrder(db, clockId) {
  return ordersOf(db, clockId)[0] || null;
}

// 未结束定型单：未放行、未作废的那张。每只表至多一张。
function openOrder(db, clockId) {
  return ordersOf(db, clockId).find((item) => OPEN_STATUSES.includes(item.status)) || null;
}

function isActive(record) {
  return !record.voided;
}

function activeAdjustments(db, clockId) {
  return db.adjustments.filter((item) => item.clockId === clockId && isActive(item));
}

function activeRetests(db, clockId) {
  return db.retests.filter((item) => item.clockId === clockId && isActive(item));
}

function activeReleases(db, clockId) {
  return db.releases.filter((item) => item.clockId === clockId && isActive(item));
}

function latestOf(list, dateField) {
  return list
    .slice()
    .sort((a, b) => new Date(b[dateField]) - new Date(a[dateField]))[0] || null;
}

function latestAdjustment(db, clockId, { includeVoided = false } = {}) {
  const list = includeVoided
    ? db.adjustments.filter((item) => item.clockId === clockId)
    : activeAdjustments(db, clockId);
  return latestOf(list, "createdAt");
}

function latestRetest(db, clockId, { includeVoided = false } = {}) {
  const list = includeVoided
    ? db.retests.filter((item) => item.clockId === clockId)
    : activeRetests(db, clockId);
  return latestOf(list, "testedAt");
}

// 最近一次“返工复核”时间；温漂连续合格只统计该时点之后的复测。
function latestReworkReviewedAt(order) {
  const reviewed = (order.reworks || [])
    .filter((item) => item.qualified && item.reviewedAt)
    .map((item) => item.reviewedAt)
    .sort()
    .reverse();
  return reviewed[0] || null;
}

// 温漂复测尾部连续合格次数（任何一次不合格即清零）。
function trailingDriftPasses(db, order) {
  const since = latestReworkReviewedAt(order);
  const rows = db.retests
    .filter(
      (item) =>
        item.clockId === order.clockId &&
        isActive(item) &&
        item.kind === "drift" &&
        item.shapeOrderId === order.id &&
        (!since || new Date(item.testedAt) >= new Date(since))
    )
    .sort((a, b) => new Date(a.testedAt) - new Date(b.testedAt));
  let count = 0;
  for (const row of rows) {
    if (row.qualified) count += 1;
    else count = 0;
  }
  return count;
}

// 放行判定。
function releaseGate(db, order) {
  if (!order) {
    return { releasable: false, reason: "no_order", message: "尚无定型单" };
  }
  if (order.status === STATUS.SUPERSEDED) {
    return { releasable: false, reason: "superseded", message: "定型单已被修订或换游丝作废" };
  }
  if (order.status === STATUS.RELEASED) {
    return { releasable: false, reason: "already_released", message: "该定型单已放行" };
  }
  if (order.status === STATUS.REWORK_REQUIRED) {
    return { releasable: false, reason: "rework_required", message: "定型不达标，必须先返工并换人复核" };
  }
  if (order.status === STATUS.AWAITING_RELEASE) {
    return { releasable: true, reason: "shape_qualified", message: "定型参数合格，可直接放行" };
  }
  // AWAITING_DRIFT
  const passes = trailingDriftPasses(db, order);
  if (passes >= REQUIRED_DRIFT_PASSES) {
    return {
      releasable: true,
      reason: "drift_passed",
      message: "换人复核后连续两次温漂复测合格，可放行",
      driftPasses: passes
    };
  }
  return {
    releasable: false,
    reason: "drift_pending",
    message: `返工后需连续 ${REQUIRED_DRIFT_PASSES} 次温漂复测合格（当前连续 ${passes} 次）`,
    driftPasses: passes
  };
}

// 列表/详情共用的钟表汇总：只看未失效结论，保证刷新后各处一致。
function clockSummary(db, clock) {
  const order = currentOrder(db, clock.id);
  const open = openOrder(db, clock.id);
  const gate = releaseGate(db, order);
  const activeRelease = latestOf(activeReleases(db, clock.id), "releasedAt");
  const latestRetestRow = latestRetest(db, clock.id);
  const latestAdjustmentRow = latestAdjustment(db, clock.id);
  return {
    ...clock,
    currentShapeOrder: order,
    openShapeOrder: open,
    gate,
    latestAdjustment: latestAdjustmentRow,
    latestRetest: latestRetestRow,
    latestRelease: activeRelease,
    // qualified = 是否持有有效放行结论（定型单 RELEASED 与放行登记互为印证）
    qualified: Boolean(activeRelease && order && order.status === STATUS.RELEASED),
    releaseReady: gate.releasable
  };
}

// ---- 写操作（在持久化模块的串行临界区内执行，参数为可自由修改的 db 克隆）----

function createClock(db, body) {
  required(body, ["code", "escapementType", "balanceFrequency"]);
  if (db.clocks.some((item) => item.code === body.code)) {
    throw new HttpError(409, "钟表编号已存在", { code: body.code });
  }
  const now = new Date().toISOString();
  const clock = {
    id: makeId("clock"),
    code: body.code,
    escapementType: body.escapementType,
    balanceFrequency: body.balanceFrequency,
    targetDailyRateSeconds: Number(body.targetDailyRateSeconds ?? 30),
    maxDailyDriftSeconds: Number(body.maxDailyDriftSeconds ?? 15),
    note: body.note || "",
    hairsprings: [],
    currentHairspringId: null,
    createdAt: now
  };
  installHairspringOnClock(clock, {
    code: body.hairspringCode || "HS-出厂游丝",
    spec: body.hairspringSpec || "",
    reason: "建档时装入",
    at: now
  });
  db.clocks.push(clock);
  return clock;
}

function installHairspringOnClock(clock, hairspring) {
  const item = {
    id: makeId("hs"),
    code: hairspring.code,
    spec: hairspring.spec || "",
    installedAt: hairspring.at || new Date().toISOString(),
    reason: hairspring.reason || "",
    active: true
  };
  for (const old of clock.hairsprings || []) old.active = false;
  clock.hairsprings = clock.hairsprings || [];
  clock.hairsprings.push(item);
  clock.currentHairspringId = item.id;
  return item;
}

function readShapeParams(body) {
  required(body, ["furnaceTempC", "soakHours", "operator"]);
  const furnaceTempC = numberField(body, "furnaceTempC");
  const soakHours = numberField(body, "soakHours");
  return { furnaceTempC, soakHours, operator: String(body.operator).trim() };
}

// 登记游丝定型单。每只表只能有一张未结束定型单：重复/并发提交 409 且不落库。
function createShapeOrder(db, clockId, body) {
  const clock = findClock(db, clockId);
  const existing = openOrder(db, clockId);
  if (existing) {
    throw new HttpError(409, "该钟表已有未结束定型单，请先放行或修订后再提交", {
      conflict: "open_shape_order",
      shapeOrderId: existing.id
    });
  }
  const { furnaceTempC, soakHours, operator } = readShapeParams(body);
  const qualified = isShapeQualified(furnaceTempC, soakHours);
  const now = new Date().toISOString();
  const version = ordersOf(db, clockId).length + 1;
  const order = {
    id: makeId("shape"),
    clockId,
    version,
    hairspringId: clock.currentHairspringId,
    furnaceTempC,
    soakHours,
    operator,
    qualified,
    status: qualified ? STATUS.AWAITING_RELEASE : STATUS.REWORK_REQUIRED,
    reworks: [],
    reason: body.reason || "",
    supersededAt: null,
    supersededBy: null,
    supersedeReason: null,
    createdAt: now,
    createdBy: operator,
    releasedAt: null
  };
  db.shapeOrders.push(order);
  return order;
}

// 返工登记：炉温仍不达标 -> 留在返工；达标 -> 必须换人复核后进入温漂复测。
function registerRework(db, orderId, body) {
  const order = findOrder(db, orderId);
  if (!OPEN_STATUSES.includes(order.status)) {
    throw new HttpError(409, "定型单已结束，不能再登记返工", { shapeOrderId: orderId });
  }
  required(body, ["operator", "reviewer"]);
  const operator = String(body.operator).trim();
  const reviewer = String(body.reviewer).trim();
  if (!operator || !reviewer) throw new HttpError(400, "缺少字段：operator, reviewer");
  if (operator === reviewer) {
    throw new HttpError(409, "返工必须换人复核，复核员不能与返工操作员为同一人", {
      conflict: "reviewer_must_differ"
    });
  }
  const furnaceTempC = numberField(body, "furnaceTempC");
  const soakHours = numberField(body, "soakHours");
  const qualified = isShapeQualified(furnaceTempC, soakHours);
  const now = new Date().toISOString();
  const rework = {
    id: makeId("rework"),
    furnaceTempC,
    soakHours,
    operator,
    reviewer,
    qualified,
    reworkedAt: now,
    // 参数不达标时复核结论为不通过、不进入温漂；后续重新登记返工即可
    reviewedAt: qualified ? now : null,
    reviewNote: body.reviewNote || "",
    note: body.note || ""
  };
  order.reworks.push(rework);
  if (qualified) order.status = STATUS.AWAITING_DRIFT;
  else order.status = STATUS.REWORK_REQUIRED;
  return { order, rework };
}

function driftQualified(clock, body, dailyDrift) {
  if (body.qualified !== undefined) return Boolean(body.qualified);
  const limit = Number(clock.maxDailyDriftSeconds ?? 15);
  return Math.abs(dailyDrift) <= limit;
}

// 温漂复测：仅在返工复核合格后的 AWAITING_DRIFT 阶段登记；连续两次合格方可放行。
function addDriftRetest(db, orderId, body) {
  const order = findOrder(db, orderId);
  if (order.status === STATUS.RELEASED || order.status === STATUS.SUPERSEDED) {
    throw new HttpError(409, "定型单已结束，不能再登记温漂复测", { shapeOrderId: orderId });
  }
  if (order.status === STATUS.REWORK_REQUIRED) {
    throw new HttpError(409, "定型/返工参数不达标，必须先返工并换人复核，才能温漂复测", {
      conflict: "rework_required"
    });
  }
  if (order.status === STATUS.AWAITING_RELEASE) {
    throw new HttpError(409, "定型参数已合格，直接放行即可，无需温漂复测", {
      conflict: "shape_qualified"
    });
  }
  const clock = findClock(db, order.clockId);
  required(body, ["dailyDriftSeconds"]);
  const dailyDrift = numberField(body, "dailyDriftSeconds");
  const amplitude = body.amplitude === undefined || body.amplitude === ""
    ? null
    : numberField(body, "amplitude");
  const qualified = driftQualified(clock, body, dailyDrift);
  const retest = {
    id: makeId("drift"),
    clockId: clock.id,
    shapeOrderId: order.id,
    hairspringId: order.hairspringId,
    adjustmentId: body.adjustmentId || null,
    kind: "drift",
    testedAt: body.testedAt || new Date().toISOString(),
    dailyDriftSeconds: dailyDrift,
    dailyRateSeconds: dailyDrift, // 兼容旧字段语义
    temperatureC: body.temperatureC === undefined || body.temperatureC === ""
      ? null
      : numberField(body, "temperatureC"),
    amplitude,
    qualified,
    voided: false,
    voidedReason: null,
    note: body.note || ""
  };
  db.retests.push(retest);
  const passes = trailingDriftPasses(db, order);
  return { retest, order, driftPasses: passes };
}

// 放行：合格定型单直接放行；返工单必须换人复核且连续两次温漂复测合格。
function releaseShapeOrder(db, orderId, body = {}) {
  const order = findOrder(db, orderId);
  const gate = releaseGate(db, order);
  if (!gate.releasable) {
    throw new HttpError(409, gate.message, { conflict: gate.reason, driftPasses: gate.driftPasses || 0 });
  }
  const now = new Date().toISOString();
  order.status = STATUS.RELEASED;
  order.releasedAt = now;
  order.releaseBasis = gate.reason;
  order.releasedBy = body.operator ? String(body.operator).trim() : order.operator;
  const release = {
    id: makeId("release"),
    clockId: order.clockId,
    shapeOrderId: order.id,
    hairspringId: order.hairspringId,
    basis: gate.reason,
    driftPasses: gate.driftPasses || 0,
    operator: order.releasedBy,
    note: body.note || "",
    voided: false,
    voidedReason: null,
    releasedAt: now
  };
  db.releases.push(release);
  return { order, release };
}

// 作废该钟表当前有效结论（调校/复测/放行），旧版留档；定型单本身由调用方决定如何处置。
function voidActiveConclusions(db, clockId, reason, now = new Date().toISOString()) {
  let count = 0;
  for (const adjustment of db.adjustments) {
    if (adjustment.clockId === clockId && !adjustment.voided) {
      adjustment.voided = true;
      adjustment.voidedAt = now;
      adjustment.voidedReason = reason;
      count += 1;
    }
  }
  for (const retest of db.retests) {
    if (retest.clockId === clockId && !retest.voided) {
      retest.voided = true;
      retest.voidedAt = now;
      retest.voidedReason = reason;
      count += 1;
    }
  }
  for (const release of db.releases) {
    if (release.clockId === clockId && !release.voided) {
      release.voided = true;
      release.voidedAt = now;
      release.voidedReason = reason;
      count += 1;
    }
  }
  return count;
}

// 修订定型单：原单及其调校/复测/放行结论立即失效留档，按新参数开新版重算。
function reviseShapeOrder(db, orderId, body) {
  const oldOrder = findOrder(db, orderId);
  if (oldOrder.status === STATUS.SUPERSEDED) {
    throw new HttpError(409, "该定型单已是旧版留档，不能再修订", {
      conflict: "superseded",
      currentShapeOrderId: currentOrder(db, oldOrder.clockId)?.id
    });
  }
  const clock = findClock(db, oldOrder.clockId);
  const { furnaceTempC, soakHours, operator } = readShapeParams(body);
  const reason = (body.reason || "修订定型单").toString();
  const now = new Date().toISOString();
  const voidedCount = voidActiveConclusions(db, clock.id, `定型单 ${oldOrder.id} 修订：${reason}`, now);
  // 同一时钟表上其它仍“未结束/已放行”的旧单也一并关闭留档。
  for (const item of ordersOf(db, clock.id)) {
    if (item.id !== oldOrder.id && item.status !== STATUS.SUPERSEDED) supersedeOrder(item, oldOrder.id, reason, now);
  }
  const newVersion = ordersOf(db, clock.id).length + 1;
  const qualified = isShapeQualified(furnaceTempC, soakHours);
  const newOrder = {
    id: makeId("shape"),
    clockId: clock.id,
    version: newVersion,
    hairspringId: clock.currentHairspringId,
    furnaceTempC,
    soakHours,
    operator,
    qualified,
    status: qualified ? STATUS.AWAITING_RELEASE : STATUS.REWORK_REQUIRED,
    reworks: [],
    reason,
    supersededAt: null,
    supersededBy: null,
    supersedeReason: null,
    createdAt: now,
    createdBy: operator,
    revisedFrom: oldOrder.id,
    releasedAt: null
  };
  supersedeOrder(oldOrder, newOrder.id, reason, now);
  db.shapeOrders.push(newOrder);
  return { oldOrder, order: newOrder, voidedCount };
}

function supersedeOrder(order, newOrderId, reason, now) {
  order.status = STATUS.SUPERSEDED;
  order.supersededAt = now;
  order.supersededBy = newOrderId;
  order.supersedeReason = reason;
}

// 更换游丝：原调校/复测/放行结论与当前定型单全部失效，装新件并按新件重开定型单。
function replaceHairspring(db, clockId, body) {
  const clock = findClock(db, clockId);
  required(body, ["code", "operator"]);
  const now = new Date().toISOString();
  const reason = `更换游丝：${body.code}` + (body.reason ? `（${body.reason}）` : "");
  const oldOrder = currentOrder(db, clockId);
  const voidedCount = voidActiveConclusions(db, clockId, reason, now);
  for (const item of ordersOf(db, clockId)) {
    if (item.status !== STATUS.SUPERSEDED) supersedeOrder(item, null, reason, now);
  }
  const hairspring = installHairspringOnClock(clock, {
    code: body.code,
    spec: body.spec || "",
    reason: body.reason || "更换游丝",
    at: now
  });
  // 新游丝必须重新登记定型；只有同时给了炉温等参数时才顺带开新单。
  let order = null;
  if (body.furnaceTempC !== undefined || body.soakHours !== undefined) {
    const qualified = isShapeQualified(numberField(body, "furnaceTempC"), numberField(body, "soakHours"));
    order = {
      id: makeId("shape"),
      clockId,
      version: ordersOf(db, clockId).length + 1,
      hairspringId: hairspring.id,
      furnaceTempC: numberField(body, "furnaceTempC"),
      soakHours: numberField(body, "soakHours"),
      operator: String(body.operator).trim(),
      qualified,
      status: qualified ? STATUS.AWAITING_RELEASE : STATUS.REWORK_REQUIRED,
      reworks: [],
      reason: "新游丝首次定型",
      supersededAt: null,
      supersededBy: null,
      supersedeReason: null,
      createdAt: now,
      createdBy: String(body.operator).trim(),
      releasedAt: null
    };
    db.shapeOrders.push(order);
  }
  return { clock, hairspring, oldOrder, order, voidedCount };
}

// 普通调校（保留原能力），自动挂到当前游丝/定型单；已失效的记录不能再新增到旧版。
function addAdjustment(db, clockId, body) {
  const clock = findClock(db, clockId);
  required(body, ["currentDailyRateSeconds", "direction", "amount"]);
  const order = currentOrder(db, clockId);
  const adjustment = {
    id: makeId("adjustment"),
    clockId,
    shapeOrderId: order ? order.id : null,
    hairspringId: clock.currentHairspringId,
    currentDailyRateSeconds: numberField(body, "currentDailyRateSeconds"),
    direction: body.direction,
    amount: body.amount,
    note: body.note || "",
    voided: false,
    voidedReason: null,
    createdAt: new Date().toISOString()
  };
  db.adjustments.push(adjustment);
  return adjustment;
}

// 普通复测（非温漂）；温漂复测请走定型单专用入口。
function addRetest(db, clockId, body) {
  const clock = findClock(db, clockId);
  required(body, ["dailyRateSeconds", "amplitude"]);
  const order = currentOrder(db, clockId);
  const dailyRate = numberField(body, "dailyRateSeconds");
  const qualified = body.qualified !== undefined
    ? Boolean(body.qualified)
    : Math.abs(dailyRate) <= Number(clock.targetDailyRateSeconds);
  const retest = {
    id: makeId("retest"),
    clockId,
    shapeOrderId: order ? order.id : null,
    hairspringId: clock.currentHairspringId,
    adjustmentId: body.adjustmentId || latestAdjustment(db, clockId)?.id || null,
    kind: "rate",
    testedAt: body.testedAt || new Date().toISOString(),
    dailyRateSeconds: dailyRate,
    amplitude: numberField(body, "amplitude"),
    qualified,
    voided: false,
    voidedReason: null,
    note: body.note || ""
  };
  db.retests.push(retest);
  return retest;
}

// 单表历史：当前有效视图 + 旧版留档全部返回。
function clockHistory(db, clockId) {
  const clock = findClock(db, clockId);
  const allAdjustments = db.adjustments
    .filter((item) => item.clockId === clockId)
    .sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
  const allRetests = db.retests
    .filter((item) => item.clockId === clockId)
    .sort((a, b) => new Date(a.testedAt) - new Date(b.testedAt));
  const allReleases = db.releases
    .filter((item) => item.clockId === clockId)
    .sort((a, b) => new Date(a.releasedAt) - new Date(b.releasedAt));
  return {
    clock,
    shapeOrders: ordersOf(db, clockId),
    adjustments: allAdjustments,
    retests: allRetests,
    releases: allReleases,
    active: {
      shapeOrder: currentOrder(db, clockId),
      openShapeOrder: openOrder(db, clockId),
      adjustments: allAdjustments.filter(isActive),
      retests: allRetests.filter(isActive),
      releases: allReleases.filter(isActive),
      latestRetest: latestRetest(db, clockId),
      gate: releaseGate(db, currentOrder(db, clockId))
    }
  };
}

// ---- 旧档一次性迁移 ----
function migrate(db, { defaultMaxDailyDrift = 15 } = {}) {
  db.shapeOrders = db.shapeOrders || [];
  db.releases = db.releases || [];
  for (const clock of db.clocks) {
    if (!Array.isArray(clock.hairsprings)) {
      const hsId = `hs_legacy_${clock.id}`;
      clock.hairsprings = [
        {
          id: hsId,
          code: "HS-历史游丝",
          spec: "",
          installedAt: clock.createdAt,
          reason: "迁移自旧档案",
          active: true
        }
      ];
      clock.currentHairspringId = hsId;
    }
    if (clock.maxDailyDriftSeconds === undefined) clock.maxDailyDriftSeconds = defaultMaxDailyDrift;
  }
  for (const adjustment of db.adjustments) {
    if (adjustment.voided === undefined) adjustment.voided = false;
    if (adjustment.voidedReason === undefined) adjustment.voidedReason = null;
    if (!adjustment.hairspringId) {
      const clock = db.clocks.find((item) => item.id === adjustment.clockId);
      adjustment.hairspringId = clock ? clock.currentHairspringId : null;
    }
    if (adjustment.shapeOrderId === undefined) adjustment.shapeOrderId = null;
  }
  for (const retest of db.retests) {
    if (retest.voided === undefined) retest.voided = false;
    if (retest.voidedReason === undefined) retest.voidedReason = null;
    if (!retest.kind) retest.kind = "rate";
    if (!retest.hairspringId) {
      const clock = db.clocks.find((item) => item.id === retest.clockId);
      retest.hairspringId = clock ? clock.currentHairspringId : null;
    }
    if (retest.shapeOrderId === undefined) retest.shapeOrderId = null;
  }
}

module.exports = {
  FURNACE_TEMP_MIN,
  FURNACE_TEMP_MAX,
  SOAK_HOURS_MIN,
  REQUIRED_DRIFT_PASSES,
  STATUS,
  OPEN_STATUSES,
  HttpError,
  makeId,
  required,
  isShapeQualified,
  findClock,
  findOrder,
  ordersOf,
  currentOrder,
  openOrder,
  activeAdjustments,
  activeRetests,
  activeReleases,
  latestAdjustment,
  latestRetest,
  trailingDriftPasses,
  releaseGate,
  clockSummary,
  clockHistory,
  createClock,
  createShapeOrder,
  registerRework,
  addDriftRetest,
  releaseShapeOrder,
  reviseShapeOrder,
  replaceHairspring,
  addAdjustment,
  addRetest,
  migrate
};
