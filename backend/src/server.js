import { config } from "./config.js";
import { createApp } from "./app.js";

const app = createApp();

app.listen(config.port, () => {
  console.log(`linkpulse-shortener backend listening on :${config.port}`);
});
