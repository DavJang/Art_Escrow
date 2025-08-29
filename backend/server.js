import express from "express";
import cors from "cors";
import crypto from "node:crypto";

const app = express();
app.use(cors());
app.use(express.json());

const escrows = new Map();

app.get("/health", (_req, res) => res.send("ok"));

app.post("/api/escrow", (req, res) => {
  const id = crypto.randomUUID();
  const { buyer = "demo-buyer", seller = "demo-seller", arbiter = "demo-arbiter", price = "1.0" } = req.body || {};
  const e = { id, buyer, seller, arbiter, price: String(price), status: "CREATED", history: [{ t: Date.now(), ev: "CREATED" }] };
  escrows.set(id, e);
  res.json(e);
});

app.post("/api/escrow/:id/fund", (req, res) => {
  const e = escrows.get(req.params.id); if (!e) return res.sendStatus(404);
  e.status = "INSPECTION"; e.history.push({ t: Date.now(), ev: "FUNDED" }); res.json(e);
});

app.post("/api/escrow/:id/confirm", (req, res) => {
  const e = escrows.get(req.params.id); if (!e) return res.sendStatus(404);
  e.status = "CONFIRMED"; e.history.push({ t: Date.now(), ev: "CONFIRMED" }); res.json(e);
});

app.get("/api/escrow/:id", (req, res) => {
  const e = escrows.get(req.params.id); if (!e) return res.sendStatus(404);
  res.json(e);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("demo api on :" + PORT));
