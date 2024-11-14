// src/index.ts
import { Hono } from "hono";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
import { z } from "zod";
import { Env } from "./types";
import { BinanceMonitorDO } from "./binance-monitor";

const app = new Hono<{ Bindings: Env }>();

app.use("*", logger());
app.use("*", cors());

// 所有请求都转发到 DO
app.all("*", async (c) => {
  const id = c.env.BINANCE_MONITOR.idFromName("default");
  const obj = c.env.BINANCE_MONITOR.get(id);
  return obj.fetch(c.req.raw);
});

export default app;
export { BinanceMonitorDO };
