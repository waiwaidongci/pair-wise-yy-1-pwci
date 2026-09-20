# 机械钟表擒纵调校API

纯后端零依赖Node服务，使用 `data/db.json` 持久化钟表档案、游丝、定型单、温漂复测、调校记录和复测记录，覆盖「游丝定型 → 返工复核 → 温漂放行」闭环。

## 模块划分

- `server.js` — 服务装配（监听端口）
- `src/router.js` — **请求入口**：路由匹配、入参校验、响应组装
- `src/domain.js` — **状态判断**：定型规格判定、定型单状态机、放行规则、失效与按新件重算
- `src/store.js` — **持久化**：db.json 读取/旧版迁移/原子写入，写操作串行化（检查与落库同锁，冲突即不写库）

## 业务规则

- 每只表同一时刻仅允许一张**未结束定型单**，重复或并发提交返回 `409` 且不落库。
- 定型须登记 `furnaceTemp`（炉温℃）、`holdingHours`（保温小时）、`operator`（操作员）；炉温不在 **180~220℃** 或保温 **不足2小时** 只能返工（`rework_required`），规格内直接放行（`released`）。
- 返工须**换人复核**（`reviewer` 不得与操作员相同），之后**连续两次温漂复测合格**才放行；不合格复测会将连续计数清零。
- **更换游丝**或**修订定型单**：原调校、复测与放行结论立即失效并按新件（新世代）重算，旧版全部留档（历史中 `current=false`）。
- 列表（`GET /clocks`）、单表历史（`GET /clocks/:id/history`）与最新复测（`GET /clocks/:id/latest-retest`）共用同一汇总口径，刷新后一致。

## 启动

```bash
PORT=3021 node server.js
```

## 主要接口

- `GET /health`
- `GET /clocks` / `POST /clocks` / `GET /clocks/:id`
- `GET /clocks/not-qualified`
- `GET /clocks/:id/history`（含游丝、定型单、温漂复测全版本留档）
- `POST /clocks/:id/adjustments` / `POST /clocks/:id/retests` / `GET /clocks/:id/latest-retest`
- `POST /clocks/:id/hairsprings`（更换游丝）
- `POST /clocks/:id/setting-orders`（登记定型单）/ `GET /clocks/:id/setting-orders`
- `GET /setting-orders?clockId=&status=` / `GET /setting-orders/:id`
- `PUT /setting-orders/:id`（修订定型单，等价 `POST /setting-orders/:id/revise`）
- `POST /setting-orders/:id/rework`（换人复核）
- `POST /setting-orders/:id/drift-retests`（温漂复测）
- `GET /adjustments?clockId=` / `GET /retests?clockId=&qualified=` / `GET /drift-retests?clockId=&settingOrderId=`

## 闭环示例

```bash
# 1. 登记定型单（炉温/保温/操作员），规格外只能返工
curl -X POST http://127.0.0.1:3021/clocks/clock_demo/setting-orders \
  -H 'Content-Type: application/json' \
  -d '{"furnaceTemp":160,"holdingHours":1,"operator":"张三"}'

# 2. 换人复核
curl -X POST http://127.0.0.1:3021/setting-orders/<orderId>/rework \
  -H 'Content-Type: application/json' -d '{"reviewer":"李四"}'

# 3. 连续两次温漂复测合格 → 放行
curl -X POST http://127.0.0.1:3021/setting-orders/<orderId>/drift-retests \
  -H 'Content-Type: application/json' -d '{"driftSeconds":8}'
curl -X POST http://127.0.0.1:3021/setting-orders/<orderId>/drift-retests \
  -H 'Content-Type: application/json' -d '{"driftSeconds":5}'

# 4. 更换游丝：原结论立即失效，按新件重算
curl -X POST http://127.0.0.1:3021/clocks/clock_demo/hairsprings \
  -H 'Content-Type: application/json' -d '{"code":"HS-NIVAROX-01"}'
```

## 测试

```bash
node test/flow.test.js   # 覆盖迁移、409不落库、并发、返工复核、连续放行、失效重算与三视图一致
```
