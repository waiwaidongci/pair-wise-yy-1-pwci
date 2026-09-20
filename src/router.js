const store = require("./store");
const domain = require("./domain");

// —— 请求入口模块：路由匹配、入参校验、调用状态判断模块、组装响应 ——

const routes = [
  "GET /health",
  "GET /clocks",
  "POST /clocks",
  "GET /clocks/not-qualified",
  "GET /clocks/:id",
  "GET /clocks/:id/history",
  "POST /clocks/:id/adjustments",
  "POST /clocks/:id/retests",
  "GET /clocks/:id/latest-retest",
  "POST /clocks/:id/hairsprings",
  "GET /clocks/:id/setting-orders",
  "POST /clocks/:id/setting-orders",
  "GET /setting-orders",
  "GET /setting-orders/:id",
  "PUT /setting-orders/:id",
  "POST /setting-orders/:id/revise",
  "POST /setting-orders/:id/rework",
  "POST /setting-orders/:id/drift-retests",
  "GET /adjustments",
  "GET /retests",
  "GET /drift-retests"
];

function send(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body, null, 2));
}

async function parseBody(req) {
  let raw = "";
  for await (const chunk of req) raw += chunk;
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    const error = new Error("请求体必须是合法JSON");
    error.status = 400;
    throw error;
  }
}

function required(body, fields) {
  const missing = fields.filter((field) => body[field] === undefined || body[field] === "");
  if (missing.length) {
    const error = new Error(`缺少字段：${missing.join(", ")}`);
    error.status = 400;
    throw error;
  }
}

async function handle(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const pathname = url.pathname;

  if (req.method === "GET" && pathname === "/health") {
    return send(res, 200, {
      ok: true,
      service: "clock-escapement-tuning-api",
      modules: { entry: "src/router.js", domain: "src/domain.js", store: "src/store.js" },
      rules: {
        spec: `炉温${domain.SPEC.TEMP_MIN}~${domain.SPEC.TEMP_MAX}℃且保温≥${domain.SPEC.MIN_HOLDING_HOURS}小时，否则只能返工`,
        release: `返工须换人复核，连续${domain.RELEASE_RULE.CONSECUTIVE_DRIFT_PASSES}次温漂复测合格才放行`,
        conflict: "每只表仅允许一张未结束定型单，重复或并发提交返回409且不落库",
        invalidation: "更换游丝或修订定型单，原调校、复测与放行结论立即失效并按新件重算，旧版留档"
      },
      routes
    });
  }

  if (req.method === "GET" && pathname === "/clocks") {
    const db = await store.readDb();
    const qualified = url.searchParams.get("qualified");
    let data = db.clocks.map((clock) => domain.clockSummary(db, clock));
    if (qualified !== null) {
      const expected = qualified === "true";
      data = data.filter((clock) => clock.qualified === expected);
    }
    return send(res, 200, { data });
  }

  if (req.method === "POST" && pathname === "/clocks") {
    const body = await parseBody(req);
    required(body, ["code", "escapementType", "balanceFrequency"]);
    const data = await store.transact((db) => domain.clockSummary(db, domain.createClock(db, body)));
    return send(res, 201, { data });
  }

  if (req.method === "GET" && pathname === "/clocks/not-qualified") {
    const db = await store.readDb();
    const data = db.clocks.map((clock) => domain.clockSummary(db, clock)).filter((clock) => !clock.qualified);
    return send(res, 200, { data });
  }

  let match = pathname.match(/^\/clocks\/([^/]+)\/history$/);
  if (match && req.method === "GET") {
    const db = await store.readDb();
    const clock = domain.findClock(db, match[1]);
    return send(res, 200, { data: domain.clockHistory(db, clock) });
  }

  match = pathname.match(/^\/clocks\/([^/]+)\/adjustments$/);
  if (match && req.method === "POST") {
    const body = await parseBody(req);
    required(body, ["currentDailyRateSeconds", "direction", "amount"]);
    const data = await store.transact((db) => domain.addAdjustment(db, domain.findClock(db, match[1]), body));
    return send(res, 201, { data });
  }

  match = pathname.match(/^\/clocks\/([^/]+)\/retests$/);
  if (match && req.method === "POST") {
    const body = await parseBody(req);
    required(body, ["dailyRateSeconds", "amplitude"]);
    const data = await store.transact((db) => {
      const clock = domain.findClock(db, match[1]);
      const retest = domain.addRetest(db, clock, body);
      return { retest, clock: domain.clockSummary(db, clock) };
    });
    return send(res, 201, { data: data.retest, clock: data.clock });
  }

  match = pathname.match(/^\/clocks\/([^/]+)\/latest-retest$/);
  if (match && req.method === "GET") {
    const db = await store.readDb();
    const clock = domain.findClock(db, match[1]);
    return send(res, 200, { data: domain.latestRetest(db, clock) });
  }

  // 更换游丝：原调校、复测与放行结论立即失效并按新件重算，旧版留档
  match = pathname.match(/^\/clocks\/([^/]+)\/hairsprings$/);
  if (match && req.method === "POST") {
    const body = await parseBody(req);
    required(body, ["code"]);
    const data = await store.transact((db) => {
      const clock = domain.findClock(db, match[1]);
      const result = domain.replaceHairspring(db, clock, body);
      return { ...result, clock: domain.clockSummary(db, clock) };
    });
    return send(res, 201, { data: { hairspring: data.hairspring, invalidated: data.invalidated }, clock: data.clock });
  }

  match = pathname.match(/^\/clocks\/([^/]+)\/setting-orders$/);
  if (match && req.method === "GET") {
    const db = await store.readDb();
    const clock = domain.findClock(db, match[1]);
    const data = db.settingOrders
      .filter((order) => order.clockId === clock.id)
      .map((order) => ({ ...order, current: domain.isCurrentOrder(order, clock) }));
    return send(res, 200, { data });
  }

  // 登记定型单：每只表仅允许一张未结束定型单，重复或并发提交 409 且不落库
  if (match && req.method === "POST") {
    const body = await parseBody(req);
    required(body, ["furnaceTemp", "holdingHours", "operator"]);
    const data = await store.transact((db) => {
      const clock = domain.findClock(db, match[1]);
      const order = domain.createSettingOrder(db, clock, body);
      return { order, clock: domain.clockSummary(db, clock) };
    });
    return send(res, 201, { data: data.order, clock: data.clock });
  }

  match = pathname.match(/^\/clocks\/([^/]+)$/);
  if (match && req.method === "GET") {
    const db = await store.readDb();
    const clock = domain.findClock(db, match[1]);
    return send(res, 200, { data: domain.clockSummary(db, clock) });
  }

  // 返工：换人复核后进入温漂复测环节
  match = pathname.match(/^\/setting-orders\/([^/]+)\/rework$/);
  if (match && req.method === "POST") {
    const body = await parseBody(req);
    required(body, ["reviewer"]);
    const data = await store.transact((db) => {
      const order = domain.reworkSettingOrder(db, domain.findOrder(db, match[1]), body);
      return { order, clock: domain.clockSummary(db, domain.findClock(db, order.clockId)) };
    });
    return send(res, 200, { data: data.order, clock: data.clock });
  }

  // 温漂复测：连续两次合格才放行
  match = pathname.match(/^\/setting-orders\/([^/]+)\/drift-retests$/);
  if (match && req.method === "POST") {
    const body = await parseBody(req);
    required(body, ["driftSeconds"]);
    const data = await store.transact((db) => {
      const order = domain.findOrder(db, match[1]);
      const result = domain.addDriftRetest(db, order, body);
      return { ...result, clock: domain.clockSummary(db, domain.findClock(db, order.clockId)) };
    });
    return send(res, 201, { data: data.retest, order: data.order, released: data.released, clock: data.clock });
  }

  // 修订定型单：旧版作废留档，按新版重算（PUT 与 POST /revise 等价）
  match = pathname.match(/^\/setting-orders\/([^/]+)(?:\/revise)?$/);
  if (match && (req.method === "PUT" || (req.method === "POST" && pathname.endsWith("/revise")))) {
    const body = await parseBody(req);
    const data = await store.transact((db) => {
      const result = domain.reviseSettingOrder(db, domain.findOrder(db, match[1]), body);
      return { ...result, clock: domain.clockSummary(db, domain.findClock(db, result.order.clockId)) };
    });
    return send(res, 200, { data: { archived: data.archived, order: data.order }, clock: data.clock });
  }

  match = pathname.match(/^\/setting-orders\/([^/]+)$/);
  if (match && req.method === "GET") {
    const db = await store.readDb();
    const order = domain.findOrder(db, match[1]);
    const clock = domain.findClock(db, order.clockId);
    const driftRetests = db.driftRetests.filter((item) => item.settingOrderId === order.id);
    return send(res, 200, { data: { ...order, current: domain.isCurrentOrder(order, clock), driftRetests } });
  }

  if (req.method === "GET" && pathname === "/setting-orders") {
    const db = await store.readDb();
    const clockId = url.searchParams.get("clockId");
    const status = url.searchParams.get("status");
    const data = db.settingOrders
      .filter((order) => (!clockId || order.clockId === clockId) && (!status || order.status === status))
      .map((order) => {
        const clock = db.clocks.find((item) => item.id === order.clockId);
        return { ...order, current: clock ? domain.isCurrentOrder(order, clock) : false };
      });
    return send(res, 200, { data });
  }

  if (req.method === "GET" && pathname === "/adjustments") {
    const db = await store.readDb();
    const clockId = url.searchParams.get("clockId");
    return send(res, 200, { data: db.adjustments.filter((item) => !clockId || item.clockId === clockId) });
  }

  if (req.method === "GET" && pathname === "/retests") {
    const db = await store.readDb();
    const clockId = url.searchParams.get("clockId");
    const qualified = url.searchParams.get("qualified");
    const data = db.retests.filter((item) => {
      const matchClock = !clockId || item.clockId === clockId;
      const matchQualified = qualified === null || item.qualified === (qualified === "true");
      return matchClock && matchQualified;
    });
    return send(res, 200, { data });
  }

  if (req.method === "GET" && pathname === "/drift-retests") {
    const db = await store.readDb();
    const clockId = url.searchParams.get("clockId");
    const settingOrderId = url.searchParams.get("settingOrderId");
    const data = db.driftRetests.filter((item) => {
      const matchClock = !clockId || item.clockId === clockId;
      const matchOrder = !settingOrderId || item.settingOrderId === settingOrderId;
      return matchClock && matchOrder;
    });
    return send(res, 200, { data });
  }

  return send(res, 404, { error: "接口不存在", routes });
}

function handleRequest(req, res) {
  handle(req, res).catch((error) =>
    send(res, error.status || 500, { error: error.message || "服务器错误", ...(error.details || {}) })
  );
}

module.exports = { handleRequest, routes };
