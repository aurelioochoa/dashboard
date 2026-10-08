/* ============================================================
   routes/icons.ts — list, upload and delete device icons.

   Uploads arrive as base64 in a JSON body rather than multipart:
   the payloads are small (512 KB cap, well inside the app's 2 MB
   bodyLimit) and it keeps @fastify/multipart out of the runtime
   image for one endpoint.
   ============================================================ */

import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { PRESET_ICONS, presetIconPath } from "@homelab/shared";
import {
  deleteUserIcon,
  IconError,
  listUserIcons,
  MAX_ICON_BYTES,
  saveUserIcon,
} from "../icon-store.js";

const UploadSchema = z.object({
  name: z.string().min(1).max(120),
  mime: z.string().min(3).max(100),
  /** base64. Deliberately uncapped here: the app's 2 MB bodyLimit is the
   *  outer guard, and letting the store weigh the decoded bytes is what
   *  produces a 413 with a size in it rather than a bare schema 400. */
  data: z.string().min(1),
});

export async function iconRoutes(app: FastifyInstance): Promise<void> {
  app.get("/api/icons", async () => ({
    presets: PRESET_ICONS.map((icon) => ({ ...icon, path: presetIconPath(icon.id) })),
    user: await listUserIcons(),
    maxBytes: MAX_ICON_BYTES,
  }));

  app.post("/api/icons", async (req, reply) => {
    const body = UploadSchema.safeParse(req.body);
    if (!body.success) {
      return reply.code(400).send({ error: "Expected { name, mime, data } with data base64" });
    }

    let bytes: Buffer;
    try {
      bytes = Buffer.from(body.data.data, "base64");
    } catch {
      return reply.code(400).send({ error: "data is not valid base64" });
    }

    try {
      return await saveUserIcon(body.data.name, body.data.mime, bytes);
    } catch (err) {
      if (err instanceof IconError) return reply.code(err.status).send({ error: err.message });
      throw err;
    }
  });

  app.delete<{ Params: { name: string } }>("/api/icons/:name", async (req, reply) => {
    try {
      await deleteUserIcon(req.params.name);
      return { ok: true };
    } catch (err) {
      if (err instanceof IconError) return reply.code(err.status).send({ error: err.message });
      throw err;
    }
  });
}
