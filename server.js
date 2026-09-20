// 启动入口：业务模块拆分见 lib/
//   lib/routes.js      请求入口（HTTP 路由 / 参数解析 / 响应）
//   lib/domain.js      状态判断（定型、返工复核、温漂连测、放行、失效留档）
//   lib/persistence.js 持久化（data/db.json 原子写 + 写队列串行化）
const { server } = require("./lib/routes");

const PORT = Number(process.env.PORT || 3021);

server.listen(PORT, () => {
  console.log(`Clock hairspring shaping API running at http://127.0.0.1:${PORT}`);
});
