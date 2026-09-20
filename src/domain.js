const { makeId } = require("./store");

// —— 状态判断模块：定型规格判定、定型单状态机、放行规则、失效与按新件重算 ——

// 定型工艺窗口：炉温 180~220℃ 且保温 ≥ 2 小时
const SPEC = { TEMP_MIN: 180, TEMP_MAX: 220, MIN_HOLDING_HOURS: 2 };
// 放行规则：返工后须连续两次温漂复测合格
const RELEASE_RULE = { CONSECUTIVE_DRIFT_PASSES: 2 };

const ORDER_STATUS = {
  RELEASED: "released", // 已放行（定型单结束）
  REWORK_REQUIRED: "rework_required", // 定型不合格，只能返工
  PENDING_DRIFT_RETEST: "pending_drift_retest", // 返工已换人复核，待温漂复测
  SUPERSEDED: "superseded" // 已被修订或更换游丝取代（旧版留档）
};
const OPEN_STATUSES = [ORDER_STATUS.REWORK_REQUIRED, ORDER_STATUS.PENDING_DRIFT_RETEST];

function domainError(status, message, details) {
  const error = new Error(message);
  error.status = status;
  if (details) error.details = details;
  return error;
}

function now() {
  return new Date().toISOString();
}

function generationOf(record) {
  return record.generation ?? 1;
}

function clockGeneration(clock) {
  return generationOf(clock);
}

function isOpenOrder(order) {
  return OPEN_STATUSES.includes(order.status);
}

function isCurrent(record, clock) {
  return generationOf(record) === clockGeneration(clock);
}

function isCurrentOrder(order, clock) {
  return isCurrent(order, clock) && order.status !== ORDER_STATUS.SUPERSEDED;
}

function findClock(db, clockId) {
  const clock = db.clocks.find((item) => item.id === clockId);
  if (!clock) throw domainError(404, "钟表不存在");
  return clock;
}

function findOrder(db, orderId) {
  const order = db.settingOrders.find((item) => item.id === orderId);
  if (!order) throw domainError(404, "定型单不存在");
  return order;
}

function assertFinite(value, field) {
  if (!Number.isFinite(Number(value))) throw domainError(400, `${field} 必须是数字`);
  return Number(value);
}

function assertOperator(value) {
  const operator = String(value ?? "").trim();
  if (!operator) throw domainError(400, "缺少字段：operator");
  return operator;
}

// 定型规格判定：炉温落在 180~220℃ 且保温不少于 2 小时为合格，否则只能返工
function judgeSetting({ furnaceTemp, holdingHours }) {
  const reasons = [];
  if (!(furnaceTemp >= SPEC.TEMP_MIN && furnaceTemp <= SPEC.TEMP_MAX)) {
    reasons.push(`炉温${furnaceTemp}℃不在${SPEC.TEMP_MIN}~${SPEC.TEMP_MAX}℃范围`);
  }
  if (!(holdingHours >= SPEC.MIN_HOLDING_HOURS)) {
    reasons.push(`保温${holdingHours}小时不足${SPEC.MIN_HOLDING_HOURS}小时`);
  }
  return { inSpec: reasons.length === 0, reasons };
}

function openOrderOf(db, clock) {
  return db.settingOrders.find((order) => order.clockId === clock.id && isCurrent(order, clock) && isOpenOrder(order)) || null;
}

function activeOrderOf(db, clock) {
  return (
    db.settingOrders
      .filter((order) => order.clockId === clock.id && isCurrentOrder(order, clock))
      .sort((a, b) => b.version - a.version)[0] || null
  );
}

function latestAdjustment(db, clock) {
  return (
    db.adjustments
      .filter((item) => item.clockId === clock.id && isCurrent(item, clock))
      .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))[0] || null
  );
}

function latestRetest(db, clock) {
  return (
    db.retests
      .filter((item) => item.clockId === clock.id && isCurrent(item, clock))
      .sort((a, b) => new Date(b.testedAt) - new Date(a.testedAt))[0] || null
  );
}

function latestDriftRetest(db, clock) {
  return (
    db.driftRetests
      .filter((item) => item.clockId === clock.id && isCurrent(item, clock))
      .sort((a, b) => new Date(b.testedAt) - new Date(a.testedAt))[0] || null
  );
}

// 列表、单表历史、最新复测共用的汇总口径：只按当前世代（新件）重算
function clockSummary(db, clock) {
  const retest = latestRetest(db, clock);
  const order = activeOrderOf(db, clock);
  return {
    ...clock,
    generation: clockGeneration(clock),
    hairspring: db.hairsprings.find((item) => item.id === (clock.currentHairspringId ?? null)) || null,
    latestAdjustment: latestAdjustment(db, clock),
    latestRetest: retest,
    latestDriftRetest: latestDriftRetest(db, clock),
    currentSettingOrder: order,
    releaseStatus: order ? (order.status === ORDER_STATUS.RELEASED ? "released" : "in_progress") : "none",
    qualified: retest ? retest.qualified : false
  };
}

// 单表历史：全部世代都留档可查，current 标记是否仍生效
function clockHistory(db, clock) {
  const byClock = (items) => items.filter((item) => item.clockId === clock.id);
  return {
    clock,
    hairsprings: byClock(db.hairsprings).map((item) => ({ ...item, current: item.id === (clock.currentHairspringId ?? null) })),
    settingOrders: byClock(db.settingOrders).map((item) => ({ ...item, current: isCurrentOrder(item, clock) })),
    driftRetests: byClock(db.driftRetests).map((item) => ({ ...item, current: isCurrent(item, clock) })),
    adjustments: byClock(db.adjustments).map((item) => ({ ...item, current: isCurrent(item, clock) })),
    retests: byClock(db.retests).map((item) => ({ ...item, current: isCurrent(item, clock) })),
    latestRetest: latestRetest(db, clock),
    summary: clockSummary(db, clock)
  };
}

function createClock(db, body) {
  const clock = {
    id: makeId("clock"),
    code: body.code,
    escapementType: body.escapementType,
    balanceFrequency: body.balanceFrequency,
    targetDailyRateSeconds: Number(body.targetDailyRateSeconds ?? 30),
    note: body.note || "",
    generation: 1,
    currentHairspringId: null,
    createdAt: now()
  };
  db.clocks.push(clock);
  return clock;
}

function nextOrderVersion(db, clockId) {
  return db.settingOrders.filter((order) => order.clockId === clockId).reduce((max, order) => Math.max(max, order.version || 0), 0) + 1;
}

// 登记定型单：炉温、保温时长、操作员必填；规格内直接放行，规格外只能返工。
// 每只表同一世代只允许一张未结束定型单，重复/并发提交抛 409（持久化层不落库）。
function createSettingOrder(db, clock, body) {
  const furnaceTemp = assertFinite(body.furnaceTemp, "furnaceTemp");
  const holdingHours = assertFinite(body.holdingHours, "holdingHours");
  const operator = assertOperator(body.operator);
  const existing = openOrderOf(db, clock);
  if (existing) {
    throw domainError(409, `钟表 ${clock.code} 已存在未结束定型单 ${existing.id}，禁止重复或并发提交`, { conflictOrderId: existing.id });
  }
  const specCheck = judgeSetting({ furnaceTemp, holdingHours });
  const createdAt = now();
  const order = {
    id: makeId("setting"),
    clockId: clock.id,
    hairspringId: clock.currentHairspringId ?? null,
    generation: clockGeneration(clock),
    version: nextOrderVersion(db, clock.id),
    furnaceTemp,
    holdingHours,
    operator,
    reviewer: null,
    reviewedAt: null,
    status: specCheck.inSpec ? ORDER_STATUS.RELEASED : ORDER_STATUS.REWORK_REQUIRED,
    specCheck,
    consecutiveDriftPasses: 0,
    note: body.note || "",
    createdAt,
    releasedAt: specCheck.inSpec ? createdAt : null,
    supersededAt: null,
    supersedeReason: null,
    supersededBy: null
  };
  db.settingOrders.push(order);
  return order;
}

// 返工：必须换人复核，复核人不得与定型操作员相同
function reworkSettingOrder(db, order, body) {
  if (order.status === ORDER_STATUS.SUPERSEDED) throw domainError(409, "定型单已作废留档，不能返工");
  if (order.status !== ORDER_STATUS.REWORK_REQUIRED) {
    throw domainError(409, `定型单当前状态 ${order.status} 不允许返工复核`);
  }
  const reviewer = String(body.reviewer ?? "").trim();
  if (!reviewer) throw domainError(400, "缺少字段：reviewer");
  if (reviewer === order.operator) throw domainError(400, "返工须换人复核：复核人不能与定型操作员相同");
  order.reviewer = reviewer;
  order.reviewedAt = now();
  order.reworkNote = body.note || "";
  order.consecutiveDriftPasses = 0;
  order.status = ORDER_STATUS.PENDING_DRIFT_RETEST;
  return order;
}

// 温漂复测：仅返工复核后受理；连续两次合格才放行，不合格重新计数
function addDriftRetest(db, order, body) {
  if (order.status === ORDER_STATUS.SUPERSEDED) throw domainError(409, "定型单已作废留档，不能复测");
  if (order.status !== ORDER_STATUS.PENDING_DRIFT_RETEST) {
    throw domainError(409, `定型单当前状态 ${order.status} 不接受温漂复测`);
  }
  const driftSeconds = assertFinite(body.driftSeconds, "driftSeconds");
  const clock = findClock(db, order.clockId);
  const qualified = body.qualified !== undefined ? Boolean(body.qualified) : Math.abs(driftSeconds) <= Number(clock.targetDailyRateSeconds);
  const retest = {
    id: makeId("drift"),
    settingOrderId: order.id,
    clockId: clock.id,
    generation: generationOf(order),
    driftSeconds,
    qualified,
    testedAt: body.testedAt || now(),
    note: body.note || ""
  };
  db.driftRetests.push(retest);
  order.consecutiveDriftPasses = qualified ? (order.consecutiveDriftPasses || 0) + 1 : 0;
  const released = order.consecutiveDriftPasses >= RELEASE_RULE.CONSECUTIVE_DRIFT_PASSES;
  if (released) {
    order.status = ORDER_STATUS.RELEASED;
    order.releasedAt = now();
  }
  return { retest, order, released };
}

// 世代更替：更换游丝或修订定型单时，原调校、复测与放行结论立即失效；
// 旧记录全部留档，汇总口径只按新世代重算
function bumpGeneration(db, clock, reason) {
  const oldGeneration = clockGeneration(clock);
  clock.generation = oldGeneration + 1;
  const at = now();
  for (const item of db.settingOrders) {
    if (item.clockId === clock.id && generationOf(item) === oldGeneration && isOpenOrder(item)) {
      item.status = ORDER_STATUS.SUPERSEDED;
      item.supersededAt = at;
      item.supersedeReason = reason;
    }
  }
  return oldGeneration;
}

// 修订定型单：旧版作废留档，按新参数生成下一版并重新判定
function reviseSettingOrder(db, order, body) {
  if (order.status === ORDER_STATUS.SUPERSEDED) throw domainError(409, "定型单已作废留档，不能再次修订");
  const clock = findClock(db, order.clockId);
  const furnaceTemp = body.furnaceTemp !== undefined ? assertFinite(body.furnaceTemp, "furnaceTemp") : order.furnaceTemp;
  const holdingHours = body.holdingHours !== undefined ? assertFinite(body.holdingHours, "holdingHours") : order.holdingHours;
  const operator = body.operator !== undefined ? assertOperator(body.operator) : order.operator;
  const at = now();
  bumpGeneration(db, clock, "setting_revised");
  order.status = ORDER_STATUS.SUPERSEDED;
  order.supersededAt = at;
  order.supersedeReason = "revised";
  const specCheck = judgeSetting({ furnaceTemp, holdingHours });
  const next = {
    id: makeId("setting"),
    clockId: clock.id,
    hairspringId: clock.currentHairspringId ?? null,
    generation: clockGeneration(clock),
    version: (order.version || 1) + 1,
    furnaceTemp,
    holdingHours,
    operator,
    reviewer: null,
    reviewedAt: null,
    status: specCheck.inSpec ? ORDER_STATUS.RELEASED : ORDER_STATUS.REWORK_REQUIRED,
    specCheck,
    consecutiveDriftPasses: 0,
    note: body.note !== undefined ? body.note : order.note,
    createdAt: at,
    releasedAt: specCheck.inSpec ? at : null,
    supersededAt: null,
    supersedeReason: null,
    supersededBy: null
  };
  order.supersededBy = next.id;
  db.settingOrders.push(next);
  return { archived: order, order: next };
}

// 更换游丝：旧件退役留档，新件上位后所有结论按新件重算
function replaceHairspring(db, clock, body) {
  const code = String(body.code ?? "").trim();
  if (!code) throw domainError(400, "缺少字段：code");
  const at = now();
  const oldGeneration = bumpGeneration(db, clock, "hairspring_replaced");
  const previous = db.hairsprings.find((item) => item.id === (clock.currentHairspringId ?? null));
  if (previous) previous.replacedAt = at;
  const hairspring = {
    id: makeId("hairspring"),
    clockId: clock.id,
    code,
    version: db.hairsprings.filter((item) => item.clockId === clock.id).length + 1,
    generation: clockGeneration(clock),
    note: body.note || "",
    installedAt: at,
    replacedAt: null
  };
  db.hairsprings.push(hairspring);
  clock.currentHairspringId = hairspring.id;
  const invalidated = {
    adjustments: db.adjustments.filter((item) => item.clockId === clock.id && generationOf(item) === oldGeneration).length,
    retests: db.retests.filter((item) => item.clockId === clock.id && generationOf(item) === oldGeneration).length,
    settingOrders: db.settingOrders.filter((item) => item.clockId === clock.id && generationOf(item) === oldGeneration).length,
    driftRetests: db.driftRetests.filter((item) => item.clockId === clock.id && generationOf(item) === oldGeneration).length
  };
  return { hairspring, invalidated };
}

function addAdjustment(db, clock, body) {
  const adjustment = {
    id: makeId("adjustment"),
    clockId: clock.id,
    generation: clockGeneration(clock),
    hairspringId: clock.currentHairspringId ?? null,
    currentDailyRateSeconds: Number(body.currentDailyRateSeconds),
    direction: body.direction,
    amount: body.amount,
    note: body.note || "",
    createdAt: now()
  };
  db.adjustments.push(adjustment);
  return adjustment;
}

function addRetest(db, clock, body) {
  const adjustmentId = body.adjustmentId || latestAdjustment(db, clock)?.id || null;
  const qualified = body.qualified !== undefined
    ? Boolean(body.qualified)
    : Math.abs(Number(body.dailyRateSeconds)) <= Number(clock.targetDailyRateSeconds);
  const retest = {
    id: makeId("retest"),
    clockId: clock.id,
    generation: clockGeneration(clock),
    hairspringId: clock.currentHairspringId ?? null,
    adjustmentId,
    testedAt: body.testedAt || now(),
    dailyRateSeconds: Number(body.dailyRateSeconds),
    amplitude: Number(body.amplitude),
    qualified,
    note: body.note || ""
  };
  db.retests.push(retest);
  return retest;
}

module.exports = {
  SPEC,
  RELEASE_RULE,
  ORDER_STATUS,
  OPEN_STATUSES,
  domainError,
  clockGeneration,
  isCurrentOrder,
  findClock,
  findOrder,
  judgeSetting,
  latestAdjustment,
  latestRetest,
  latestDriftRetest,
  clockSummary,
  clockHistory,
  createClock,
  createSettingOrder,
  reworkSettingOrder,
  addDriftRetest,
  reviseSettingOrder,
  replaceHairspring,
  addAdjustment,
  addRetest
};
