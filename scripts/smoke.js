#!/usr/bin/env node
// 端到端冒烟：启动一个临时 DB 的服务实例，走游丝定型与温漂放行闭环。
// 用法：node scripts/smoke.js
const { spawn } = require("child_process");
const { mkdtempSync, existsSync } = require("fs");
const os = require("os");
const path = require("path");

const PORT = 3399;
const dir = mkdtempSync(path.join(os.tmpdir(), "clock-smoke-"));
const DB_FILE = path.join(dir, "db.json");
const BASE = `http://127.0.0.1:${PORT}`;

let failures = 0;
function check(name, cond, extra) {
  if (cond) {
    console.log(`  ok - ${name}`);
  } else {
    failures += 1;
    console.error(`FAIL - ${name}`, extra !== undefined ? JSON.stringify(extra) : "");
  }
}

async function req(method, urlPath, body) {
  const res = await fetch(`${BASE}${urlPath}`, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const json = await res.json();
  return { status: res.status, json };
}

async function waitForHealth() {
  for (let i = 0; i < 50; i += 1) {
    try {
      const r = await req("GET", "/health");
      if (r.status === 200) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("server did not start");
}

const child = spawn(process.execPath, [path.join(__dirname, "..", "server.js")], {
  env: { ...process.env, PORT: String(PORT), DB_FILE },
  stdio: ["ignore", "pipe", "inherit"]
});

async function main() {
  await waitForHealth();
  console.log("# 1. 建档");
  const c1 = await req("POST", "/clocks", {
    code: "SMOKE-1",
    escapementType: "瑞士杠杆式",
    balanceFrequency: "28800vph",
    targetDailyRateSeconds: 10,
    maxDailyDriftSeconds: 5
  });
  check("建档 201", c1.status === 201, c1.json);
  const id = c1.json.data.id;

  console.log("# 2. 并发提交两张定型单 -> 一张 201 一张 409，仅落库一张");
  const [a, b] = await Promise.all([
    req("POST", `/clocks/${id}/shape-orders`, {
      furnaceTempC: 200, soakHours: 2, operator: "张三", reason: "首炉"
    }),
    req("POST", `/clocks/${id}/shape-orders`, {
      furnaceTempC: 205, soakHours: 3, operator: "李四", reason: "并发重复提交"
    })
  ]);
  const statuses = [a.status, b.status].sort();
  check("并发结果 201+409", JSON.stringify(statuses) === JSON.stringify([201, 409]), statuses);
  check("409 不落库（列表只有一张）", (await req("GET", `/clocks/${id}/shape-orders?include=all`)).json.data.length === 1);

  // 首炉参数合格 -> 可直接放行；先验证直接放行路径
  console.log("# 3. 合格定型单直接放行");
  const orderId = a.status === 201 ? a.json.data.id : b.json.data.id;
  check("首炉合格 awaiting_release", (await req("GET", `/shape-orders/${orderId}`)).json.data.status === "awaiting_release");
  const rel = await req("POST", `/shape-orders/${orderId}/release`, { operator: "班组长" });
  check("直接放行 200", rel.status === 200, rel.json);
  check("列表 qualified=true", (await req("GET", `/clocks/${id}`)).json.data.qualified === true);

  console.log("# 4. 修订定型单 -> 旧结论失效留档，新版重算");
  const rev = await req("POST", `/shape-orders/${orderId}/revise`, {
    furnaceTempC: 170, soakHours: 1, operator: "王五", reason: "炉温曲线异常重做"
  });
  check("修订 201", rev.status === 201, rev.json);
  check("旧单 superseded 留档", rev.json.archivedShapeOrder.status === "superseded");
  check("新单 rework_required", rev.json.data.status === "rework_required", rev.json.data);
  check("旧放行已失效", rev.json.voidedRecords >= 1);
  check("钟表回到未放行", (await req("GET", `/clocks/${id}`)).json.data.qualified === false);

  const newOrderId = rev.json.data.id;
  let r = await req("POST", `/shape-orders/${newOrderId}/release`, {});
  check("返工态强行放行 -> 409", r.status === 409, r.json);

  console.log("# 5. 返工：同人复核 409；参数仍不达标继续返工");
  r = await req("POST", `/shape-orders/${newOrderId}/reworks`, {
    furnaceTempC: 200, soakHours: 2, operator: "王五", reviewer: "王五"
  });
  check("同人复核 -> 409", r.status === 409, r.json);
  r = await req("POST", `/shape-orders/${newOrderId}/reworks`, {
    furnaceTempC: 179, soakHours: 2, operator: "王五", reviewer: "赵六", note: "炉温偏低"
  });
  check("换人但炉温179 -> 201 且仍 rework_required",
    r.status === 201 && r.json.shapeOrder.status === "rework_required", r.json);
  r = await req("POST", `/shape-orders/${newOrderId}/reworks`, {
    furnaceTempC: 210, soakHours: 2.5, operator: "王五", reviewer: "赵六", note: "重新进炉"
  });
  check("换人复核合格 -> awaiting_drift_retest",
    r.status === 201 && r.json.shapeOrder.status === "awaiting_drift_retest", r.json);

  console.log("# 6. 温漂复测：一次合格不能放行；失败清零；连续两次合格才放行");
  r = await req("POST", `/shape-orders/${newOrderId}/release`, {});
  check("0 次复测放行 -> 409", r.status === 409);

  r = await req("POST", `/shape-orders/${newOrderId}/drift-retests`, { dailyDriftSeconds: 4 });
  check("第1次温漂合格 (1/2)", r.status === 201 && r.json.driftPasses === 1, r.json);
  r = await req("POST", `/shape-orders/${newOrderId}/release`, {});
  check("仅1次合格放行 -> 409", r.status === 409);

  r = await req("POST", `/shape-orders/${newOrderId}/drift-retests`, { dailyDriftSeconds: 9 });
  check("第2次温漂超标 -> 合格=false 且清零", r.status === 201 && r.json.data.qualified === false && r.json.driftPasses === 0, r.json);

  r = await req("POST", `/shape-orders/${newOrderId}/drift-retests`, { dailyDriftSeconds: -3 });
  check("再第1次合格", r.json.driftPasses === 1, r.json);
  r = await req("POST", `/shape-orders/${newOrderId}/drift-retests`, { dailyDriftSeconds: 5, temperatureC: 8, amplitude: 260 });
  check("再第2次合格 (2/2)", r.status === 201 && r.json.driftPasses === 2 && r.json.data.qualified === true, r.json);

  r = await req("POST", `/shape-orders/${newOrderId}/release`, { operator: "赵六", note: "温漂连续合格放行" });
  check("两次合格后放行 200", r.status === 200 && r.json.shapeOrder.status === "released", r.json);
  check("钟表 qualified 恢复", (await req("GET", `/clocks/${id}`)).json.data.qualified === true);

  console.log("# 7. 列表 / 单表历史 / 最新复测 三处一致");
  const list = await req("GET", "/clocks");
  const listRow = list.json.data.find((x) => x.id === id);
  const history = await req("GET", `/clocks/${id}/history`);
  const latest = await req("GET", `/clocks/${id}/latest-retest`);
  check("列表最新复测 == latest-retest", listRow.latestRetest.id === latest.json.data.id);
  check("历史最新有效复测 == latest-retest", history.json.data.active.latestRetest.id === latest.json.data.id);
  check("历史保留两版定型单", history.json.data.shapeOrders.length === 2, history.json.data.shapeOrders.map((o) => o.version));
  check("历史含全部复测（失效+有效）", history.json.data.retests.length >= 2);
  check("默认列表不含失效留档",
    (await req("GET", `/releases?clockId=${id}`)).json.data.length === 1 &&
    (await req("GET", `/releases?clockId=${id}`)).json.data.every((x) => !x.voided));
  check("include=all 可查失效留档",
    (await req("GET", `/releases?clockId=${id}&include=all`)).json.data.some((x) => x.voided));

  console.log("# 8. 换游丝 -> 原定型/调校/复测/放行立即失效，按新件重开");
  const rep = await req("POST", `/clocks/${id}/hairsprings/replace`, {
    code: "HS-NIVAROX-新件", spec: "合金游丝", operator: "钱七", reason: "原游丝磁化",
    furnaceTempC: 200, soakHours: 2
  });
  check("换件 201", rep.status === 201, rep.json);
  check("旧定型单被作废", rep.json.data.supersededShapeOrderId === newOrderId);
  check("新件新定型单 awaiting_release", rep.json.data.newShapeOrder.status === "awaiting_release", rep.json.data.newShapeOrder);
  check("换件后 qualified 失效", (await req("GET", `/clocks/${id}`)).json.data.qualified === false);
  check("最新复测不再返回旧件记录", (await req("GET", `/clocks/${id}/latest-retest`)).json.data === null);
  check("档案保留两根游丝", (await req("GET", `/clocks/${id}`)).json.data.hairsprings.length === 2);

  console.log("# 9. 第二只表：返工态不能登记温漂复测");
  const c2 = await req("POST", "/clocks", { code: "SMOKE-2", escapementType: "x", balanceFrequency: "y" });
  const id2 = c2.json.data.id;
  const bad = await req("POST", `/clocks/${id2}/shape-orders`, { furnaceTempC: 221, soakHours: 2, operator: "甲" });
  check("221℃ 不合格 -> rework_required", bad.json.data.status === "rework_required", bad.json.data);
  const dr = await req("POST", `/shape-orders/${bad.json.data.id}/drift-retests`, { dailyDriftSeconds: 1 });
  check("返工态温漂复测 -> 409", dr.status === 409, dr.json);

  check("临时 DB 已生成（持久化落盘）", existsSync(DB_FILE));

  if (failures) {
    console.error(`\n${failures} 项失败`);
    process.exitCode = 1;
  } else {
    console.log("\n全部通过 ✔");
  }
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => child.kill());
