const { readFile, writeFile, mkdir, rename } = require("fs/promises");
const path = require("path");

// —— 持久化模块：db.json 的读取、旧版数据迁移、原子写入与写操作串行化 ——

const DB_FILE = process.env.DB_FILE || path.join(__dirname, "..", "data", "db.json");

const initialData = {
  clocks: [
    {
      id: "clock_demo",
      code: "CLK-1890-07",
      escapementType: "瑞士杠杆式",
      balanceFrequency: "18000vph",
      targetDailyRateSeconds: 20,
      note: "怀表机芯，走时偏快",
      generation: 1,
      currentHairspringId: null,
      createdAt: new Date().toISOString()
    }
  ],
  hairsprings: [],
  settingOrders: [],
  driftRetests: [],
  adjustments: [
    {
      id: "adjustment_demo",
      clockId: "clock_demo",
      generation: 1,
      hairspringId: null,
      currentDailyRateSeconds: 68,
      direction: "慢针方向",
      amount: "游丝快慢针向慢侧微调0.4格",
      note: "初次调校，先保守处理",
      createdAt: new Date().toISOString()
    }
  ],
  retests: [
    {
      id: "retest_demo",
      clockId: "clock_demo",
      generation: 1,
      hairspringId: null,
      adjustmentId: "adjustment_demo",
      testedAt: new Date().toISOString(),
      dailyRateSeconds: 31,
      amplitude: 248,
      qualified: false,
      note: "仍偏快，振幅尚可"
    }
  ]
};

// 旧版数据就地归一：补世代号、游丝/定型/温漂集合，保证状态判断模块看到统一的结构
function migrate(db) {
  db.clocks ||= [];
  db.hairsprings ||= [];
  db.settingOrders ||= [];
  db.driftRetests ||= [];
  db.adjustments ||= [];
  db.retests ||= [];
  for (const clock of db.clocks) {
    clock.generation ??= 1;
    clock.currentHairspringId ??= null;
  }
  for (const record of [...db.adjustments, ...db.retests]) {
    record.generation ??= 1;
    record.hairspringId ??= null;
  }
  for (const order of db.settingOrders) {
    order.generation ??= 1;
    order.consecutiveDriftPasses ??= 0;
  }
  for (const retest of db.driftRetests) {
    retest.generation ??= 1;
  }
  return db;
}

async function ensureDb() {
  await mkdir(path.dirname(DB_FILE), { recursive: true });
  try {
    JSON.parse(await readFile(DB_FILE, "utf8"));
  } catch {
    await writeDb(JSON.parse(JSON.stringify(initialData)));
  }
}

async function readDb() {
  await ensureDb();
  return migrate(JSON.parse(await readFile(DB_FILE, "utf8")));
}

// 先写临时文件再改名，避免读到写了一半的库
async function writeDb(data) {
  const tmp = `${DB_FILE}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify(data, null, 2));
  await rename(tmp, DB_FILE);
}

// 写操作串行化：检查与落库在同一个锁内完成，
// 并发/重复提交在锁内重新读库判断，冲突时抛错即不写库
let queue = Promise.resolve();
function withLock(fn) {
  const run = queue.then(fn);
  queue = run.catch(() => {});
  return run;
}

async function transact(fn) {
  return withLock(async () => {
    const db = await readDb();
    const result = await fn(db);
    await writeDb(db);
    return result;
  });
}

function makeId(prefix) {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

module.exports = { DB_FILE, readDb, writeDb, transact, withLock, makeId, migrate };
