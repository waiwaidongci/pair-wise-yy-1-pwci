// 持久化模块：负责 data/db.json 的读写、一次性迁移与并发安全。
// - 读请求直接走内存缓存；写请求经 chain 串行化，保证“先查后写”在同一临界区内完成。
// - 落盘采用临时文件 + rename 原子替换，避免写一半产生坏档。
const { readFile, writeFile, mkdir, rename } = require("fs/promises");
const path = require("path");
const { migrate } = require("./domain");

const DB_FILE = process.env.DB_FILE || path.join(__dirname, "..", "data", "db.json");
const DEFAULT_MAX_DAILY_DRIFT = 15;

// 旧版演示数据（迁移前形态），首次启动且无档案时使用，migrate 会补齐新结构。
const initialData = {
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

let cached = null;
// 写队列：任何失败都不能拖垮后续请求，因此每轮单独吞错。
let chain = Promise.resolve();

async function load() {
  if (cached) return cached;
  await mkdir(path.dirname(DB_FILE), { recursive: true });
  let db;
  try {
    db = JSON.parse(await readFile(DB_FILE, "utf8"));
  } catch {
    db = JSON.parse(JSON.stringify(initialData));
  }
  migrate(db, { defaultMaxDailyDrift: DEFAULT_MAX_DAILY_DRIFT });
  cached = db;
  return db;
}

async function atomicWrite(db) {
  const tmp = `${DB_FILE}.tmp.${process.pid}.${Math.random().toString(36).slice(2, 8)}`;
  await writeFile(tmp, JSON.stringify(db, null, 2));
  await rename(tmp, DB_FILE);
}

// 只读视图，调用方不得修改返回对象。
async function getDb() {
  return load();
}

// 在串行临界区内执行一次变更：克隆 -> mutator 改内存 -> 原子落盘 -> 换缓存。
// 并发提交（例如重复创建定型单）会被排队，第二个请求读到的已是第一个请求的结果。
function update(mutator) {
  const run = chain.then(async () => {
    const db = structuredClone(await load());
    const result = await mutator(db);
    await atomicWrite(db);
    cached = db;
    return result;
  });
  chain = run.then(
    () => undefined,
    () => undefined
  );
  return run;
}

module.exports = { DB_FILE, getDb, update };
