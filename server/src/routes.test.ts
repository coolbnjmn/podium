import { describe, it, expect } from "vitest";
import express from "express";
import request from "supertest";
import { createRouter } from "./routes.js";

describe("routes", () => {
  it("GET /api/health returns ok", async () => {
    const app = express();
    app.use(createRouter());
    const res = await request(app).get("/api/health");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: "ok" });
  });
});
