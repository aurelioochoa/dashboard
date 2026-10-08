/* ============================================================
   routes/config.ts — GET/PUT the dashboard config.
   ============================================================ */

import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { ConfigError, loadConfig, readConfigText, saveConfigText } from "../config-store.js";

const SaveBodySchema = z.object({ yaml: z.string().max(1_000_000) });

export async function configRoutes(app: FastifyInstance): Promise<void> {
  app.get("/api/config", async () => loadConfig());

  /** Raw YAML text, for the editor. */
  app.get("/api/config/raw", async (_req, reply) => {
    reply.type("text/yaml; charset=utf-8");
    return readConfigText();
  });

  app.put("/api/config", async (req, reply) => {
    const body = SaveBodySchema.safeParse(req.body);
    if (!body.success) {
      return reply.code(400).send({ error: "Expected a JSON body of { yaml: string }" });
    }

    try {
      const config = await saveConfigText(body.data.yaml);
      return { ok: true, devices: config.devices.length };
    } catch (err) {
      if (err instanceof ConfigError) {
        return reply.code(422).send({ error: err.message, issues: err.issues });
      }
      throw err;
    }
  });

  /** Dry-run validation so the editor can show errors without saving. */
  app.post("/api/config/validate", async (req, reply) => {
    const body = SaveBodySchema.safeParse(req.body);
    if (!body.success) {
      return reply.code(400).send({ error: "Expected a JSON body of { yaml: string }" });
    }
    try {
      const { parseConfig } = await import("../config-store.js");
      const config = parseConfig(body.data.yaml);
      return { ok: true, devices: config.devices.length };
    } catch (err) {
      if (err instanceof ConfigError) {
        return reply.code(422).send({ error: err.message, issues: err.issues });
      }
      throw err;
    }
  });
}
