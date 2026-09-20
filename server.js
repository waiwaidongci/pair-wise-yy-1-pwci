const http = require("http");
const { handleRequest } = require("./src/router");

// 服务装配：请求入口 → src/router.js，状态判断 → src/domain.js，持久化 → src/store.js
const PORT = Number(process.env.PORT || 3021);

const server = http.createServer((req, res) => {
  handleRequest(req, res);
});

server.listen(PORT, () => {
  console.log(`Clock escapement tuning API running at http://127.0.0.1:${PORT}`);
});
