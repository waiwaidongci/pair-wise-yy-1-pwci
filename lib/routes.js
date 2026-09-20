// 请求入口模块：只负责 HTTP 路由、解析与响应；业务判定全部在 domain，落盘全部在 persistence。
const http = require("http");
const store = require("./persistence");
const domain = require("./domain");

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
  "POST /clocks/:id/hairsprings/replace",
  "GET /clocks/:id/shape-orders",
  "POST /clocks/:id/shape-orders",
  "GET /shape-orders/:orderId",
  "POST /shape-orders/:orderId/reworks",
  "POST /shape-orders/:orderId/drift-retests",
  "POST /shape-orders/:orderId/release",
  "POST /shape-orders/:orderId/revise",
  "GET /adjustments",
  "GET /retests",
  "GET /releases"
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
    throw new domain.HttpError(400, "请求体必须是合法JSON");
  }
}

// include=all 时连旧版留档（voided/superseded）一起返回；默认只看当前有效结论。
function scopeFlag(url) {
  return url.searchParams.get("include") === "all" || url.searchParams.get("active") === "false";
}

function withSummary(db, clockId) {
  return domain.clockSummary(db, domain.findClock(db, clockId));
}

async function handle(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const p = url.pathname;

  if (req.method === "GET" && p === "/health") {
    return send(res, 200, {
      ok: true,
      service: "clock-hairspring-shaping-api",
      rules: {
        furnaceTempRange: [domain.FURNACE_TEMP_MIN, domain.FURNACE_TEMP_MAX],
        minSoakHours: domain.SOAK_HOURS_MIN,
        requiredConsecutiveDriftPasses: domain.REQUIRED_DRIFT_PASSES,
        reworkReviewerMustDiffer: true
      },
      routes
    });
  }

  if (req.method === "GET" && p === "/clocks") {
    const db = await store.getDb();
    let data = db.clocks.map((clock) => domain.clockSummary(db, clock));
    const qualified = url.searchParams.get("qualified");
    if (qualified !== null) data = data.filter((clock) => clock.qualified === (qualified === "true"));
    const releaseReady = url.searchParams.get("releaseReady");
    if (releaseReady !== null) data = data.filter((clock) => clock.releaseReady === (releaseReady === "true"));
    return send(res, 200, { data });
  }

  if (req.method === "POST" && p === "/clocks") {
    const body = await parseBody(req);
    const clock = await store.update((db) => domain.createClock(db, body));
    const db = await store.getDb();
    return send(res, 201, { data: domain.clockSummary(db, clock) });
  }

  if (req.method === "GET" && p === "/clocks/not-qualified") {
    const db = await store.getDb();
    const data = db.clocks.map((clock) => domain.clockSummary(db, clock)).filter((clock) => !clock.qualified);
    return send(res, 200, { data });
  }

  let m = p.match(/^\/clocks\/([^/]+)$/);
  if (m && req.method === "GET") {
    const db = await store.getDb();
    return send(res, 200, { data: domain.clockSummary(db, domain.findClock(db, m[1])) });
  }

  m = p.match(/^\/clocks\/([^/]+)\/history$/);
  if (m && req.method === "GET") {
    const db = await store.getDb();
    return send(res, 200, { data: domain.clockHistory(db, m[1]) });
  }

  m = p.match(/^\/clocks\/([^/]+)\/latest-retest$/);
  if (m && req.method === "GET") {
    const db = await store.getDb();
    domain.findClock(db, m[1]);
    return send(res, 200, {
      data: domain.latestRetest(db, m[1], { includeVoided: scopeFlag(url) })
    });
  }

  m = p.match(/^\/clocks\/([^/]+)\/adjustments$/);
  if (m && req.method === "POST") {
    const body = await parseBody(req);
    const adjustment = await store.update((db) => domain.addAdjustment(db, m[1], body));
    return send(res, 201, { data: adjustment, clock: await withSummary(await store.getDb(), m[1]) });
  }

  m = p.match(/^\/clocks\/([^/]+)\/retests$/);
  if (m && req.method === "POST") {
    const body = await parseBody(req);
    const retest = await store.update((db) => domain.addRetest(db, m[1], body));
    return send(res, 201, { data: retest, clock: await withSummary(await store.getDb(), m[1]) });
  }

  m = p.match(/^\/clocks\/([^/]+)\/hairsprings\/replace$/);
  if (m && req.method === "POST") {
    const body = await parseBody(req);
    const result = await store.update((db) => domain.replaceHairspring(db, m[1], body));
    const db = await store.getDb();
    return send(res, 201, {
      data: {
        clock: domain.clockSummary(db, result.clock),
        hairspring: result.hairspring,
        newShapeOrder: result.order,
        supersededShapeOrderId: result.oldOrder ? result.oldOrder.id : null,
        voidedRecords: result.voidedCount
      }
    });
  }

  m = p.match(/^\/clocks\/([^/]+)\/shape-orders$/);
  if (m) {
    domain.findClock(await store.getDb(), m[1]);
    if (req.method === "GET") {
      const db = await store.getDb();
      const all = domain.ordersOf(db, m[1]);
      return send(res, 200, {
        data: scopeFlag(url) ? all : all.filter((item) => item.status !== domain.STATUS.SUPERSEDED),
        current: domain.currentOrder(db, m[1]),
        open: domain.openOrder(db, m[1])
      });
    }
    if (req.method === "POST") {
      const body = await parseBody(req);
      const order = await store.update((db) => domain.createShapeOrder(db, m[1], body));
      const db = await store.getDb();
      return send(res, 201, { data: order, gate: domain.releaseGate(db, order), clock: domain.clockSummary(db, m[1]) });
    }
  }

  m = p.match(/^\/shape-orders\/([^/]+)$/);
  if (m && req.method === "GET") {
    const db = await store.getDb();
    const order = domain.findOrder(db, m[1]);
    const driftPasses = domain.trailingDriftPasses(db, order);
    return send(res, 200, { data: order, driftPasses, gate: domain.releaseGate(db, order) });
  }

  m = p.match(/^\/shape-orders\/([^/]+)\/reworks$/);
  if (m && req.method === "POST") {
    const body = await parseBody(req);
    const result = await store.update((db) => domain.registerRework(db, m[1], body));
    const db = await store.getDb();
    return send(res, 201, {
      data: result.rework,
      shapeOrder: result.order,
      gate: domain.releaseGate(db, result.order),
      message: result.rework.qualified
        ? "返工参数合格且换人复核通过，进入温漂复测"
        : "返工参数仍不达标（炉温须180-220℃且保温≥2小时），只能继续返工"
    });
  }

  m = p.match(/^\/shape-orders\/([^/]+)\/drift-retests$/);
  if (m && req.method === "POST") {
    const body = await parseBody(req);
    const result = await store.update((db) => domain.addDriftRetest(db, m[1], body));
    const db = await store.getDb();
    return send(res, 201, {
      data: result.retest,
      driftPasses: result.driftPasses,
      gate: domain.releaseGate(db, result.order),
      message: result.retest.qualified
        ? `温漂复测合格（连续 ${result.driftPasses}/${domain.REQUIRED_DRIFT_PASSES}）`
        : "温漂复测不合格，连续合格次数清零"
    });
  }

  m = p.match(/^\/shape-orders\/([^/]+)\/release$/);
  if (m && req.method === "POST") {
    const body = await parseBody(req);
    const result = await store.update((db) => domain.releaseShapeOrder(db, m[1], body));
    const db = await store.getDb();
    return send(res, 200, {
      data: result.release,
      shapeOrder: result.order,
      clock: domain.clockSummary(db, result.order.clockId)
    });
  }

  m = p.match(/^\/shape-orders\/([^/]+)\/revise$/);
  if (m && req.method === "POST") {
    const body = await parseBody(req);
    const result = await store.update((db) => domain.reviseShapeOrder(db, m[1], body));
    const db = await store.getDb();
    return send(res, 201, {
      data: result.order,
      archivedShapeOrder: result.oldOrder,
      gate: domain.releaseGate(db, result.order),
      voidedRecords: result.voidedCount,
      message: "旧版定型单、调校、复测与放行结论已失效留档，按新版重算"
    });
  }

  if (req.method === "GET" && p === "/adjustments") {
    const db = await store.getDb();
    const clockId = url.searchParams.get("clockId");
    let data = db.adjustments.filter((item) => !clockId || item.clockId === clockId);
    if (!scopeFlag(url)) data = data.filter((item) => !item.voided);
    return send(res, 200, { data });
  }

  if (req.method === "GET" && p === "/retests") {
    const db = await store.getDb();
    const clockId = url.searchParams.get("clockId");
    const qualified = url.searchParams.get("qualified");
    const kind = url.searchParams.get("kind");
    let data = db.retests.filter((item) => {
      if (clockId && item.clockId !== clockId) return false;
      if (qualified !== null && item.qualified !== (qualified === "true")) return false;
      if (kind && item.kind !== kind) return false;
      if (!scopeFlag(url) && item.voided) return false;
      return true;
    });
    return send(res, 200, { data });
  }

  if (req.method === "GET" && p === "/releases") {
    const db = await store.getDb();
    const clockId = url.searchParams.get("clockId");
    let data = db.releases.filter((item) => !clockId || item.clockId === clockId);
    if (!scopeFlag(url)) data = data.filter((item) => !item.voided);
    return send(res, 200, { data });
  }

  return send(res, 404, { error: "接口不存在", routes });
}

const server = http.createServer((req, res) => {
  handle(req, res).catch((error) => {
    send(res, error.status || 500, {
      error: error.message || "服务器错误",
      ...(error.shapeOrderId ? { shapeOrderId: error.shapeOrderId } : {}),
      ...(error.conflict ? { conflict: error.conflict } : {})
    });
  });
});

module.exports = { server, handle, routes };
