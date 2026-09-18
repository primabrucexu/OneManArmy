import { createApp } from "./app.js";

const host = "127.0.0.1";
const port = 8765;
const app = createApp();

app.listen(port, host, () => {
  console.log(`OneManArmy 已启动：http://${host}:${port}`);
});
