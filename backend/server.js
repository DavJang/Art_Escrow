import express from "express";
import cors from "cors";
import crypto from "node:crypto";

const app = express();
app.use(cors());
app.use(express.json());

/** In-memory stores (데모용) **/
const arts = new Map();     // artId -> { id, seller, title, image, price, sellerDeposit, status, createdAt, history[] }
const escrows = new Map();  // escrowId -> { id, artId, buyer, seller, arbiter, price, buyerDeposit, sellerDeposit, status, pendingUntil, createdAt, updatedAt, history[] }
const timers = new Map();   // escrowId -> timeout

const now = () => Date.now();
const push = (o, ev, extra={}) => o.history.push({ t: now(), ev, ...extra });
const setStatus = (o, status, extra={}) => { o.status = status; push(o, status, extra); o.updatedAt = now(); };

/** 타임락 30s **/
function startPendingTimer(escrowId){
  clearPendingTimer(escrowId);
  const e = escrows.get(escrowId); if (!e) return;
  const ms = 30_000;
  e.pendingUntil = now() + ms;
  setStatus(e, "PENDING", { until: e.pendingUntil });
  const h = setTimeout(() => {
    const cur = escrows.get(escrowId);
    if (!cur || cur.status !== "PENDING") return;
    // 자동 확정: 에스크로의 본대금은 판매자에게, 예치금은 각자 반환
    setStatus(cur, "CONFIRMED", { auto:true });
    escrows.set(escrowId, cur);
  }, ms);
  timers.set(escrowId, h);
}
function clearPendingTimer(escrowId){
  const h = timers.get(escrowId);
  if (h) clearTimeout(h);
  timers.delete(escrowId);
}

/** 헬스 **/
app.get("/health", (_req,res)=>res.send("ok"));

/** 0) 마켓: 판매자 작품 등록 (10% 예치) **/
app.post("/api/art", (req,res) => {
  const id = crypto.randomUUID();
  const {
    seller = "sellersellersellerseller",
    title = "Untitled",
    image = "",             // URL or empty
    price = "1.0",          // KAIA 단위(문자열로 유지)
    arbiter = "arbiterarbiterarbiter"
  } = req.body || {};
  const p = parseFloat(price);
  const sellerDeposit = +(p * 0.10).toFixed(6); // 10%
  const art = {
    id, seller, title, image,
    price: String(p),
    sellerDeposit,          // 판매자 예치금(데모: 프론트에서 가상잔액 이동)
    arbiter,
    status: "LISTED",
    createdAt: now(),
    updatedAt: now(),
    history: []
  };
  push(art, "LISTED", { sellerDeposit });
  arts.set(id, art);
  res.json(art);
});
app.get("/api/art", (_req,res)=> {
  res.json(Array.from(arts.values()));
});

/** 1) 구매자: 작품 구매 제안(create) -> 에스크로 생성(CREATED) **/
app.post("/api/art/:artId/buy", (req,res)=>{
  const art = arts.get(req.params.artId);
  if (!art) return res.status(404).json({error:"art not found"});
  if (art.status !== "LISTED") return res.status(400).json({error:"not LISTED"});
  const id = crypto.randomUUID();
  const { buyer = "buyerbuyerbuyerbuyer" } = req.body || {};
  const e = {
    id, artId: art.id,
    buyer, seller: art.seller, arbiter: art.arbiter,
    price: art.price,
    buyerDeposit: 0,                  // confirm 때 10% 요구(데모: 프론트에서 가상잔액 이동)
    sellerDeposit: art.sellerDeposit, // 판매자 예치금은 등록 시점에 이미 걸려있다고 가정
    status: "CREATED",
    pendingUntil: null,
    createdAt: now(),
    updatedAt: now(),
    history: []
  };
  push(e, "CREATED", { fromArt: art.id });
  escrows.set(id, e);
  res.json(e);
});

/** 2) 판매자: 구매요청 확인 or 거절 **/
app.post("/api/escrow/:id/seller-confirm", (req,res)=>{
  const e = escrows.get(req.params.id); if(!e) return res.sendStatus(404);
  if (e.status !== "CREATED") return res.status(400).json({error:"not CREATED"});
  // 판매자 수락: 거래 시작 → INITIATED → PENDING(30s)
  // 이때 구매자 10% 예치 요구 (데모: 프론트에서 buyer→escrow 가상이동)
  setStatus(e, "INITIATED", { buyerDepositRequired: +(parseFloat(e.price)*0.10).toFixed(6) });
  startPendingTimer(e.id);
  escrows.set(e.id, e);
  res.json(e);
});
app.post("/api/escrow/:id/seller-reject", (req,res)=>{
  const e = escrows.get(req.params.id); if(!e) return res.sendStatus(404);
  if (e.status !== "CREATED") return res.status(400).json({error:"not CREATED"});
  setStatus(e, "REJECTED"); // 계약 취소(기록만 남김)
  clearPendingTimer(e.id);
  escrows.set(e.id, e);
  res.json(e);
});

/** 3) 구매자: 확정(confirm) or 거절(=분쟁 진입) **/
app.post("/api/escrow/:id/buyer-confirm", (req,res)=>{
  const e = escrows.get(req.params.id); if(!e) return res.sendStatus(404);
  if (e.status !== "PENDING") return res.status(400).json({error:"not PENDING"});
  // 확정: 본대금 판매자에게, 예치금은 각자 반환(데모에서는 기록만)
  setStatus(e, "CONFIRMED", { by:"buyer" });
  clearPendingTimer(e.id);
  escrows.set(e.id, e);
  res.json(e);
});
app.post("/api/escrow/:id/buyer-reject", (req,res)=>{
  const e = escrows.get(req.params.id); if(!e) return res.sendStatus(404);
  if (e.status !== "PENDING") return res.status(400).json({error:"not PENDING"});
  // 분쟁 진입: DISPUTED (시간제한 해제)
  setStatus(e, "DISPUTED");
  clearPendingTimer(e.id);
  escrows.set(e.id, e);
  res.json(e);
});

/** 4) 중재자: 판정 (예치금에서 10% 수령) **/
app.post("/api/escrow/:id/arbitrate", (req,res)=>{
  const e = escrows.get(req.params.id); if(!e) return res.sendStatus(404);
  if (e.status !== "DISPUTED") return res.status(400).json({error:"not DISPUTED"});
  const { winner } = req.body || {};
  if (winner !== "buyer" && winner !== "seller") return res.status(400).json({error:"winner must be buyer|seller"});

  // 규칙: 중재자 보수 10%는 "해당 측의 예치금"에서 지급
  const P = parseFloat(e.price);
  const ten = +(P * 0.10).toFixed(6);

  if (winner === "buyer"){
    // 결과: 본대금 P는 구매자에게 환불, 판매자 예치금 10%는 중재자에게
    setStatus(e, "RESOLVED_BUYER", { feeFrom:"sellerDeposit", fee: ten });
  } else {
    // 결과: 본대금 P는 판매자에게 지급, 구매자 예치금 10%는 중재자에게
    setStatus(e, "RESOLVED_SELLER", { feeFrom:"buyerDeposit", fee: ten });
  }
  escrows.set(e.id, e);
  res.json(e);
});

/** 조회 **/
app.get("/api/escrow", (_req,res)=> res.json(Array.from(escrows.values())));
app.get("/api/escrow/:id", (req,res)=> {
  const e = escrows.get(req.params.id);
  if(!e) return res.sendStatus(404);
  res.json(e);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("demo api on :" + PORT));
