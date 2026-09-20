# 机械钟表游丝定型与温漂放行 API

零依赖 Node 服务，用 `data/db.json` 持久化钟表档案、游丝更换记录、游丝定型单、
调校、复测与放行登记，实现 **定型 → 放行 / 返工换人复核 → 连续两次温漂复测合格 → 放行** 闭环。

## 启动

```bash
PORT=3021 node server.js          # 可用 DB_FILE 指定其他档案路径
node scripts/smoke.js             # 端到端冒烟（自动起临时端口与临时档案）
```

## 模块划分

| 模块 | 职责 |
| --- | --- |
| `server.js` | 启动入口 |
| `lib/routes.js` | 请求入口：HTTP 路由、JSON 解析、响应/错误码（不写业务判定） |
| `lib/domain.js` | 状态判断：定型合格、返工复核、温漂连测、放行门禁、失效留档（纯逻辑） |
| `lib/persistence.js` | 持久化：`db.json` 读写、旧档迁移、写队列串行化、临时文件原子落盘 |

写操作在持久化模块的写队列中串行执行「克隆内存档 → 业务变更 → 原子 rename 落盘」，
因此重复或并发的定型单提交第二笔会读到第一笔结果并返回 409，**不会落库**。

## 业务规则

1. 每只表至多有一张**未结束定型单**（`awaiting_release` / `rework_required` /
   `awaiting_drift_retest`）。重复或并发提交返回 `409`，响应里带 `shapeOrderId`。
2. 定型须登记 `furnaceTempC`（炉温）、`soakHours`（保温时长）、`operator`（操作员）。
   炉温 **180–220℃（含端点）** 且保温 **≥2 小时** 为合格，可直接放行；
   否则定型单进入 `rework_required`，只能返工。
3. 返工须登记返工操作员与复核员，**两人不能为同一人**（否则 409）。
   返工炉温仍不达标则继续留在返工；换人复核且参数合格后进入温漂复测。
4. 温漂复测需**连续两次合格**才满足放行；中途任意一次不合格，连续计数清零。
   合格判定：`|dailyDriftSeconds| ≤ 钟表 maxDailyDriftSeconds`（默认 15，建档可配）。
5. **修订定型单**或**更换游丝**：原调校、复测与放行结论立即标记 `voided` 失效，
   旧定型单置为 `superseded` 并整体留档；按新参数 / 新游丝开新版重算。
6. 列表、单表历史、最新复测三处只统计未失效结论，刷新后保持一致；
   列表接口加 `include=all` 可查看含旧版留档的全量记录。

## 定型单状态

```
            炉温180-220℃且保温≥2h
   登记定型 ───────────────────────► awaiting_release ──放行──► released
            炉温/保温不达标
            ───────► rework_required
                        │ 返工参数仍不合格：留在 rework_required
                        │ 返工参数合格 + 换人复核（reviewer≠operator）
                        ▼
                 awaiting_drift_retest
                        │ 温漂：失败清零；连续 2 次合格
                        ▼
                    release（登记 releases 后 released）

   revise / 换游丝：当前版本及全部有效结论立即失效，旧版 superseded 留档，开新版重算
```

## 接口

- `GET /health`
- 钟表：`GET /clocks`（支持 `qualified=`、`releaseReady=`）、`POST /clocks`、
  `GET /clocks/not-qualified`、`GET /clocks/:id`、`GET /clocks/:id/history`
- 游丝：`POST /clocks/:id/hairsprings/replace`
- 定型单：`GET/POST /clocks/:id/shape-orders`、`GET /shape-orders/:orderId`、
  `POST /shape-orders/:orderId/reworks`（返工+换人复核）、
  `POST /shape-orders/:orderId/drift-retests`（温漂复测）、
  `POST /shape-orders/:orderId/release`（放行）、
  `POST /shape-orders/:orderId/revise`（修订，旧版留档）
- 调校/复测（保留原能力）：`POST /clocks/:id/adjustments`、`POST /clocks/:id/retests`、
  `GET /clocks/:id/latest-retest`、`GET /adjustments`、`GET /retests`（支持 `kind=drift|rate`）
- `GET /releases`（放行登记）

上述列表类接口默认只返回有效记录，`include=all` 返回含 `voided` / `superseded` 的留档。

## 闭环示例

```bash
# 1) 定型合格直接放行
curl -X POST http://127.0.0.1:3021/clocks/$CID/shape-orders \
  -H 'Content-Type: application/json' \
  -d '{"furnaceTempC":200,"soakHours":2,"operator":"张三"}'
curl -X POST http://127.0.0.1:3021/shape-orders/$SID/release \
  -H 'Content-Type: application/json' -d '{"operator":"班组长"}'

# 2) 定型不达标：返工换人复核 → 连续两次温漂复测合格 → 放行
curl -X POST http://127.0.0.1:3021/shape-orders/$SID/reworks \
  -H 'Content-Type: application/json' \
  -d '{"furnaceTempC":210,"soakHours":2.5,"operator":"王五","reviewer":"赵六"}'
curl -X POST http://127.0.0.1:3021/shape-orders/$SID/drift-retests \
  -H 'Content-Type: application/json' -d '{"dailyDriftSeconds":3,"temperatureC":8}'
curl -X POST http://127.0.0.1:3021/shape-orders/$SID/drift-retests \
  -H 'Content-Type: application/json' -d '{"dailyDriftSeconds":-2,"temperatureC":38}'
curl -X POST http://127.0.0.1:3021/shape-orders/$SID/release \
  -H 'Content-Type: application/json' -d '{"operator":"赵六"}'

# 3) 换游丝（原结论失效留档；可顺带提交新件首炉参数）
curl -X POST http://127.0.0.1:3021/clocks/$CID/hairsprings/replace \
  -H 'Content-Type: application/json' \
  -d '{"code":"HS-NIVAROX-NEW","operator":"钱七","reason":"原游丝磁化",
       "furnaceTempC":200,"soakHours":2}'
```
