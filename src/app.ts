import express, { Request, Response, NextFunction } from "express";
import { identifyRouter } from "./routes/identify";
import { logger } from "./logger";

// ── Express application (exported separately from server startup) ─────────────
// Separating app from server.listen() lets tests import the app without
// binding a real port — supertest handles that internally.

const app = express();

app.use(express.json());

// Request logging middleware — logs method + path + status for every request
app.use((req: Request, res: Response, next: NextFunction) => {
  res.on("finish", () => {
    logger.info(`${req.method} ${req.path} → ${res.statusCode}`);
  });
  next();
});

// Health check — useful for Render/Railway uptime monitors
app.get("/", (_req: Request, res: Response) => {
  res.json({ status: "ok", service: "bitespeed-identity-reconciliation" });
});

// Routes
app.use("/identify", identifyRouter);

// 404 handler
app.use((_req: Request, res: Response) => {
  res.status(404).json({ error: "Not found" });
});

// Global error handler — catches anything thrown by route handlers
// eslint-disable-next-line @typescript-eslint/no-unused-vars
app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
  logger.error("Unhandled Express error", { message: err.message, stack: err.stack });
  res.status(500).json({ error: "Internal server error." });
});

export default app;
