const { spawn } = require("child_process");
const path = require("path");
const fs = require("fs");

// 闭环流程测试：游丝定型 → 返工复核 → 温漂放行 → 换件/修订失效重算
const PORT = 3399;
const BASE = `http://127.0.0.1:${PORT}`;
const DB_FILE = path.join(__dirname, "..", "data", "test-db.json");

// 先放一份旧格式数据，验证迁移兼容
const legacySeed = {
  clocks: [
    {
      id: "clock_demo",
      code: "CLK-1890-07",
      escapementType: "瑞士杠杆式",
      balanceFrequency: "18000vph",
      targetDailyRateSeconds: 20,
      note: "怀表机芯，走时偏快",
      createdAt: "2026-06-16T00:00:00.000Z"
    }
  ],
  adjustments: [
    {
      id: "adjustment_demo",
      clockId: "clock_demo",
      currentDailyRateSeconds: 68,
      direction: "慢针方向",
      amount: "游丝快慢针向慢侧微调0.4格",
      note: "初次调校，先保守处理",
      createdAt: "2026-06-16T00:00:00.000Z"
    }
  ],
  retests: [
    {
      id: "retest_demo",
      clockId: "clock_demo",
      adjustmentId: "adjustment_demo",
      testedAt: "2026-06-16T00:00:00.000Z",
      dailyRateSeconds: 31,
      amplitude: 248,
      qualified: false,
      note: "仍偏快，振幅尚可"
    }
  ]
};

let failures = 0;
function assert(condition, message) {
  if (condition) {
    console.log(`  ✓ ${message}`);
  } else {
    failures += 1;
    console.error(`  ✗ ${message}`);
  }
}

async function api(method, pathname, body) {
  const res = await fetch(BASE + pathname, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  let json = null;
  try {
    json = await res.json();
  } catch {
    // 忽略非JSON响应
  }
  return { status: res.status, body: json };
}

async function waitReady() {
  for (let i = 0; i < 50; i += 1) {
    try {
      const res = await fetch(`${BASE}/health`);
      if (res.ok) return;
    } catch {
      // 服务尚未就绪
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("服务启动超时");
}

async function main() {
  fs.rmSync(DB_FILE, { force: true });
  fs.writeFileSync(DB_FILE, JSON.stringify(legacySeed, null, 2));
  const server = spawn(process.execPath, [path.join(__dirname, "..", "server.js")], {
    env: { ...process.env, PORT: String(PORT), DB_FILE },
    stdio: "inherit"
  });

  try {
    await waitReady();

    console.log("\n[1] 旧数据迁移与既有接口");
    let res = await api("GET", "/clocks");
    const demo = res.body.data.find((clock) => clock.id === "clock_demo");
    assert(res.status === 200 && demo, "旧格式数据迁移后仍可查询");
    assert(demo.latestRetest && demo.latestRetest.id === "retest_demo" && demo.qualified === false, "演示表最新复测与合格结论保持原样");

    console.log("\n[2] 登记定型单：规格外只能返工，重复/并发提交 409 且不落库");
    res = await api("POST", "/clocks", { code: "CLK-2026-01", escapementType: "同轴擒纵", balanceFrequency: "25200vph", targetDailyRateSeconds: 15 });
    const clockId = res.body.data.id;
    assert(res.status === 201 && clockId, "新建钟表");

    res = await api("POST", `/clocks/${clockId}/setting-orders`, { furnaceTemp: 150, holdingHours: 1, operator: "张三" });
    assert(res.status === 201 && res.body.data.status === "rework_required", "炉温150℃/保温1小时 → 只能返工");
    assert(res.body.data.specCheck.reasons.length === 2, "判定原因同时记录炉温与保温时长");
    const orderId = res.body.data.id;

    const beforeConflict = fs.readFileSync(DB_FILE, "utf8");
    res = await api("POST", `/clocks/${clockId}/setting-orders`, { furnaceTemp: 200, holdingHours: 3, operator: "李四" });
    assert(res.status === 409 && res.body.conflictOrderId === orderId, "存在未结束定型单时重复提交返回409");
    assert(fs.readFileSync(DB_FILE, "utf8") === beforeConflict, "409 不落库");
    res = await api("GET", `/setting-orders?clockId=${clockId}`);
    assert(res.body.data.length === 1, "定型单仍只有一张");

    const [r1, r2] = await Promise.all([
      api("POST", `/clocks/${clockId}/setting-orders`, { furnaceTemp: 210, holdingHours: 2, operator: "李四" }),
      api("POST", `/clocks/${clockId}/setting-orders`, { furnaceTemp: 210, holdingHours: 2, operator: "李四" })
    ]);
    assert([r1.status, r2.status].sort().join(",") === "409,409", "未结束单存在时并发提交双双409");
    res = await api("GET", `/setting-orders?clockId=${clockId}`);
    assert(res.body.data.length === 1, "并发冲突后仍只有一张定型单");

    console.log("\n[3] 返工须换人复核");
    res = await api("POST", `/setting-orders/${orderId}/rework`, { reviewer: "张三" });
    assert(res.status === 400, "复核人与操作员相同被拒绝");
    res = await api("POST", `/setting-orders/${orderId}/rework`, { reviewer: "李四", note: "换李四复核返工" });
    assert(res.status === 200 && res.body.data.status === "pending_drift_retest", "换人复核后进入温漂复测");

    console.log("\n[4] 连续两次温漂复测合格才放行");
    res = await api("POST", `/setting-orders/${orderId}/drift-retests`, { driftSeconds: 8 });
    assert(res.status === 201 && res.body.released === false && res.body.order.consecutiveDriftPasses === 1, "第一次合格未放行");
    res = await api("POST", `/setting-orders/${orderId}/drift-retests`, { driftSeconds: -40 });
    assert(res.body.order.consecutiveDriftPasses === 0 && res.body.released === false, "不合格复测使连续计数清零");
    res = await api("POST", `/setting-orders/${orderId}/drift-retests`, { driftSeconds: 6 });
    res = await api("POST", `/setting-orders/${orderId}/drift-retests`, { driftSeconds: 9 });
    assert(res.body.released === true && res.body.order.status === "released", "连续两次合格后放行");
    assert(res.body.clock.releaseStatus === "released", "钟表汇总放行状态同步");
    res = await api("POST", `/setting-orders/${orderId}/rework`, { reviewer: "王五" });
    assert(res.status === 409, "已放行定型单不能再返工");

    console.log("\n[5] 调校与复测后，更换游丝立即失效并按新件重算");
    await api("POST", `/clocks/${clockId}/adjustments`, { currentDailyRateSeconds: 25, direction: "快针方向", amount: "微调0.2格" });
    res = await api("POST", `/clocks/${clockId}/retests`, { dailyRateSeconds: 10, amplitude: 260 });
    assert(res.body.clock.qualified === true, "复测合格后钟表判定合格");

    res = await api("POST", `/clocks/${clockId}/hairsprings`, { code: "HS-NIVAROX-01", note: "更换游丝" });
    assert(res.status === 201 && res.body.data.hairspring.version === 1, "新游丝登记成功");
    assert(res.body.data.invalidated.adjustments === 1 && res.body.data.invalidated.retests === 1 && res.body.data.invalidated.settingOrders === 1, "失效统计覆盖调校/复测/定型单");
    assert(res.body.clock.latestRetest === null && res.body.clock.qualified === false && res.body.clock.releaseStatus === "none", "原调校、复测与放行结论立即失效");

    res = await api("GET", `/clocks/${clockId}/history`);
    const history = res.body.data;
    assert(history.retests.length === 1 && history.retests[0].current === false, "旧复测留档且标记失效");
    assert(history.settingOrders.length === 1 && history.settingOrders[0].status === "released" && history.settingOrders[0].current === false, "旧放行结论留档但不再生效");
    assert(history.driftRetests.length === 4 && history.driftRetests.every((item) => item.current === false), "旧温漂复测全部留档失效");

    console.log("\n[6] 规格内定型单直接放行（边界值）");
    res = await api("POST", `/clocks/${clockId}/setting-orders`, { furnaceTemp: 220, holdingHours: 2, operator: "赵六" });
    assert(res.status === 201 && res.body.data.status === "released", "炉温220℃/保温2小时（边界）直接放行");
    const releasedOrderId = res.body.data.id;

    console.log("\n[7] 修订定型单：旧版留档，结论按新版重算");
    await api("POST", `/clocks/${clockId}/adjustments`, { currentDailyRateSeconds: 18, direction: "慢针方向", amount: "微调0.1格" });
    res = await api("POST", `/clocks/${clockId}/retests`, { dailyRateSeconds: 5, amplitude: 265 });
    assert(res.body.clock.qualified === true, "新件复测合格");

    res = await api("PUT", `/setting-orders/${releasedOrderId}`, { furnaceTemp: 175, holdingHours: 1.5, operator: "赵六", note: "炉温登记有误，修订" });
    assert(res.status === 200 && res.body.data.archived.status === "superseded", "旧版定型单作废留档");
    assert(res.body.data.order.version === res.body.data.archived.version + 1 && res.body.data.order.status === "rework_required", "新版按修订参数重判为返工");
    assert(res.body.clock.latestRetest === null && res.body.clock.qualified === false && res.body.clock.releaseStatus === "in_progress", "修订后原调校/复测/放行结论立即失效");
    const revisedOrderId = res.body.data.order.id;

    res = await api("GET", `/clocks/${clockId}/history`);
    const revised = res.body.data.settingOrders.find((order) => order.id === releasedOrderId);
    assert(revised && revised.current === false && revised.supersededBy === revisedOrderId, "历史中新旧版本关联留档");

    console.log("\n[8] 修订版走完整返工闭环");
    res = await api("POST", `/setting-orders/${revisedOrderId}/rework`, { reviewer: "钱七" });
    assert(res.status === 200, "修订版换人复核");
    await api("POST", `/setting-orders/${revisedOrderId}/drift-retests`, { driftSeconds: 4 });
    res = await api("POST", `/setting-orders/${revisedOrderId}/drift-retests`, { driftSeconds: 7 });
    assert(res.body.released === true && res.body.clock.releaseStatus === "released", "修订版连续两次温漂合格后放行");

    console.log("\n[9] 列表、单表历史与最新复测刷新后一致");
    await api("POST", `/clocks/${clockId}/adjustments`, { currentDailyRateSeconds: 12, direction: "慢针方向", amount: "微调0.05格" });
    await api("POST", `/clocks/${clockId}/retests`, { dailyRateSeconds: 6, amplitude: 270 });
    const [listRes, historyRes, latestRes] = await Promise.all([
      api("GET", "/clocks"),
      api("GET", `/clocks/${clockId}/history`),
      api("GET", `/clocks/${clockId}/latest-retest`)
    ]);
    const summary = listRes.body.data.find((clock) => clock.id === clockId);
    const latestId = latestRes.body.data ? latestRes.body.data.id : null;
    assert((summary.latestRetest ? summary.latestRetest.id : null) === latestId, "列表与最新复测一致");
    assert((historyRes.body.data.latestRetest ? historyRes.body.data.latestRetest.id : null) === latestId, "单表历史与最新复测一致");
    assert(summary.qualified === historyRes.body.data.summary.qualified && summary.releaseStatus === historyRes.body.data.summary.releaseStatus, "列表与历史结论一致");

    console.log("\n[10] 并发创建：同一只表同时提交两张定型单");
    res = await api("POST", "/clocks", { code: "CLK-2026-02", escapementType: "杠杆式", balanceFrequency: "21600vph" });
    const clock2 = res.body.data.id;
    const [c1, c2] = await Promise.all([
      api("POST", `/clocks/${clock2}/setting-orders`, { furnaceTemp: 190, holdingHours: 1, operator: "甲" }),
      api("POST", `/clocks/${clock2}/setting-orders`, { furnaceTemp: 195, holdingHours: 1, operator: "乙" })
    ]);
    const statuses = [c1.status, c2.status].sort().join(",");
    assert(statuses === "201,409", `并发提交恰有一单成功一单409（实际 ${statuses}）`);
    res = await api("GET", `/setting-orders?clockId=${clock2}`);
    assert(res.body.data.length === 1, "并发后库中仅一张定型单");
  } finally {
    server.kill();
  }

  console.log(failures === 0 ? "\n全部断言通过" : `\n${failures} 条断言失败`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
