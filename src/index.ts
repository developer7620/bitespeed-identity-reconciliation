import app from "./app";
import { logger } from "./logger";

const PORT = parseInt(process.env.PORT ?? "3000", 10);

app.listen(PORT, () => {
  logger.info(`Server started`, { port: PORT, env: process.env.NODE_ENV ?? "development" });
});
