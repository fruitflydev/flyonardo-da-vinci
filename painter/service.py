"""
Flyonardo da Vinci - the painter.

Every 12 s window: read Robinhood Chain, gate each channel against its own history, drive
the sensory groups at those rates, run the brain forward in short control steps, and turn
each step's descending output into one pen stroke. The chain's blocks are the brush's
clock; the fly's ink is its gate (see canvas.py).

Nothing here decides where the line goes. The only editorial choices are which chain signal
lands on which sensory group (rh.py, measured and disclosed), the pixels-per-step scale
(motor.py), and the brush distance. Everything else is the connectome.

  GET /state          live canvas, brush, block, price, contract
  GET /strokes?from=  packed stroke log as JSON ints
  GET /canvas.png     snapshot of the current canvas
  GET /canvas/<id>.png, /manifest/<id>.json   a frozen, claimed canvas
  GET /stream         SSE: stroke, brush, canvas, state
"""
import asyncio
import hashlib
import json
import os
import time
from pathlib import Path

import numpy as np
from fastapi import FastAPI, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, Response, StreamingResponse

import backrooms_dictionary as bd
import canvas as C
import rh
from flysim import FlyBrain
from onchain import OnChain
from motor import Motor

HERE = Path(__file__).parent
DATA = Path(os.environ.get("FLYO_DATA_DIR") or (HERE / "data" / "runtime"))
GAIN = float(os.environ.get("FLYO_GAIN") or 0.15)          # the calibrated global scale
WINDOW_MS = int(os.environ.get("FLYO_WINDOW_MS") or 12000)
STEP_MS = float(os.environ.get("FLYO_STEP_MS") or 100.0)   # brain time per control step
STEPS = int(os.environ.get("FLYO_STEPS") or 10)            # control steps (strokes) a window
# 10 steps x 100 ms = 1 s of brain time a window. Measured cost is 0.26x real time, so
# that is ~4 s of the 12 s window, leaving room for the chain read. Shorter steps were
# tried first and drew almost nothing: see motor.py.
BRUSH_PX = float(os.environ.get("FLYO_BRUSH_PX") or C.BRUSH_PX)
CONTRACT = (os.environ.get("FLYO_CONTRACT") or "").strip() or None
ORIGINS = [o.strip() for o in (os.environ.get("CORS_ORIGINS") or
                               "https://flybrain.online,https://www.flybrain.online").split(",") if o.strip()]

STATE_PATH = DATA / "painter.json"
VERSION = "0.1.0"


def sha(obj):
    return "0x" + hashlib.sha256(json.dumps(obj, sort_keys=True, separators=(",", ":")).encode()).hexdigest()


class Painter:
    def __init__(self):
        DATA.mkdir(parents=True, exist_ok=True)
        self.brain = FlyBrain(graph_path=HERE / "data" / "graph.npz")
        self.motor = Motor(self.brain, HERE / "data" / "body-annotations.feather")
        self.gains = np.full(self.brain.n_types, GAIN, dtype=np.float32)
        self.steps_per_control = int(round(STEP_MS / self.brain.p.dt))

        self.groups = {}
        for cid, sel in rh.GROUPS.items():
            if "dictionary" in sel:
                ids = bd.groups(self.brain, [sel["dictionary"]])[sel["dictionary"]]
            else:
                ids = self.brain.where(**sel)
            self.groups[cid] = np.asarray(np.unique(ids), dtype=np.int64)
        self.group_sizes = {k: int(len(v)) for k, v in self.groups.items()}

        self.rpc = rh.Rpc()
        self.chain = OnChain(self.rpc)
        self.gates = rh.Gates()
        self.cursor = rh.Cursor(self.rpc)
        self.bstate = None                 # membrane state, carried across windows
        self.frame = None
        self.rate_hz = {}
        self.last_commit = None
        self.recent = []
        self.rpc_ok = True
        self.subs = set()

        s = json.loads(STATE_PATH.read_text()) if STATE_PATH.exists() else {}
        self.canvas = C.Canvas(s.get("canvas", {}).get("id", 1), brush_px=BRUSH_PX,
                               state=s.get("canvas") or None)
        self.gates.load(s.get("gates"))
        self.motor.load(s.get("motor"))
        self.last_commit = s.get("last_commit")
        self.recent = s.get("recent", [])
        self.log = C.Log(DATA / "strokes", self.canvas.id)
        on_disk = self.log.count()
        if on_disk != self.canvas.n:
            # the log is the truth; a torn shutdown can leave the summary behind it
            print(f"stroke log has {on_disk}, state said {self.canvas.n}: trusting the log", flush=True)
            self.canvas.n = on_disk

    # ---- persistence --------------------------------------------------------------

    def save(self):
        STATE_PATH.write_text(json.dumps(dict(
            canvas=self.canvas.state(), gates=self.gates.dump(), motor=self.motor.state(),
            last_commit=self.last_commit, recent=self.recent[-24:]), indent=1))

    # ---- one window ---------------------------------------------------------------

    def window(self, end_ms):
        try:
            frame, rates = rh.read_window(self.rpc, self.cursor, self.gates, end_ms)
            self.rpc_ok = True
        except rh.RpcError as e:
            self.rpc_ok = False
            print(f"chain read failed: {str(e)[:140]}", flush=True)
            return None
        if frame is None:
            return None
        self.frame, self.rate_hz = frame, rates

        drive = {tuple(self.groups[c]): float(hz) for c, hz in rates.items()
                 if hz > 0 and len(self.groups[c])}
        blocks = frame.get("blockList") or []
        strokes, brush_events = [], []
        for i in range(STEPS):
            r = self.brain.run(drive, self.steps_per_control, gains=self.gains,
                               record=self.motor.groups, seed=(frame["toBlock"] * 97 + i),
                               state=self.bstate)
            self.bstate = r["_state"]
            turn, speed, self.detail = self.motor.readout(r)
            s = self.canvas.step(turn, speed)
            if s:
                strokes.append(s)
            # pair stroke i with a block from this window: the strokes span the window, so
            # the brush walks the window's blocks in order rather than all firing at once
            if blocks:
                b = blocks[min(int(i * len(blocks) / max(1, STEPS)), len(blocks) - 1)]
                col = self.canvas.maybe_change_brush(b["n"], b["hash"])
                if col is not None:
                    brush_events.append(dict(colour=col, block=b["n"]))
            elif frame.get("headHash"):
                col = self.canvas.maybe_change_brush(frame["headBlock"], frame["headHash"])
                if col is not None:
                    brush_events.append(dict(colour=col, block=frame["headBlock"]))

        first = self.canvas.n - len(strokes)
        self.log.append(strokes)
        self.input_hash = sha(dict(raw=frame["raw"], fromBlock=frame["fromBlock"],
                                   toBlock=frame["toBlock"]))
        self.save()

        claimed = self.settle()
        try:
            tx = self.chain.commit(self.canvas.id, "0x" + self.canvas.root.hex(),
                                   self.input_hash, self.canvas.n)
            if tx:
                self.last_commit = self.chain.last_commit
                print(f"committed canvas {self.canvas.id} at {self.canvas.n} strokes: {tx}",
                      flush=True)
                self.save()
        except Exception as e:
            print(f"commit failed: {type(e).__name__}: {str(e)[:140]}", flush=True)

        return dict(first=first, strokes=strokes, brush=brush_events, claimed=claimed,
                    root="0x" + self.canvas.root.hex(), inputHash=self.input_hash)

    def settle(self):
        """Has anyone claimed? The contract's id only moves forward, so one view call
        answers it and a claim can never be missed."""
        if not self.chain.address:
            return None
        try:
            cid = self.chain.current_id()
            self.chain.read_price()
            self.chain.read_balance()
        except Exception as e:
            print(f"contract read failed: {type(e).__name__}: {str(e)[:120]}", flush=True)
            return None
        if not cid or cid <= self.canvas.id:
            return None
        rec = self.chain.frozen(self.canvas.id) or {}
        tx = self.chain.claim_tx(self.canvas.id, rec.get("claimBlock") or 0)
        claimed_id = self.canvas.id
        new_id = self.freeze(claimed_id, rec.get("claimer"), tx, rec.get("claimBlock") or 0)
        print(f"canvas {claimed_id} claimed by {rec.get('claimer')} "
              f"({rec.get('strokes')} strokes frozen); canvas {new_id} is blank", flush=True)
        return dict(canvasId=claimed_id, owner=rec.get("claimer"), tx=tx,
                    frozen=rec, next=new_id)

    # ---- a claimed canvas ---------------------------------------------------------

    def freeze(self, canvas_id, owner, tx, block):
        """Render and pin the canvas that was claimed, then start a blank one."""
        strokes = self.log.read(0, 10_000_000)
        img = C.render(strokes, self.canvas.w, self.canvas.h)
        img.save(DATA / f"canvas-{canvas_id:06d}.png")
        C.write_manifest(DATA / f"canvas-{canvas_id:06d}.json", self.canvas,
                         getattr(self, "input_hash", None), block,
                         extra=dict(owner=owner, tx=tx, claimed=True,
                                    strokeRoot="0x" + self.canvas.root.hex()))
        self.recent.append(dict(canvasId=int(canvas_id), owner=owner, tx=tx,
                                at=int(time.time()), strokes=self.canvas.n))
        self.log.close()
        self.canvas = C.Canvas(canvas_id + 1, brush_px=BRUSH_PX)
        self.log = C.Log(DATA / "strokes", self.canvas.id)
        self.save()
        return self.canvas.id

    # ---- views --------------------------------------------------------------------

    def state(self):
        f = self.frame or {}
        return dict(
            ok=True, version=VERSION, chainId=rh.CHAIN_ID,
            canvasId=self.canvas.id, strokes=self.canvas.n,
            w=self.canvas.w, h=self.canvas.h,
            pos=dict(x=round(self.canvas.x, 1), y=round(self.canvas.y, 1),
                     heading=round(self.canvas.heading, 1)),
            motor=getattr(self, "detail", None),
            colour=self.canvas.colour, palette=list(C.PALETTE), paper=C.PAPER,
            brushChanges=self.canvas.brush_changes, brushPx=self.canvas.brush_px,
            inkSinceBrush=round(self.canvas.ink, 1), lineLength=round(self.canvas.distance, 1),
            strokeRoot="0x" + self.canvas.root.hex(),
            block=f.get("toBlock", 0), blocks=f.get("blocks", 0), warm=f.get("warm", True),
            rpcOk=self.rpc_ok, rates=self.rate_hz, raw=f.get("raw", {}),
            groups=self.group_sizes,
            token=rh.FLYBRAIN, recent=self.recent[-12:],
            **self.chain.state(),
        )


app = FastAPI(title="flyonardo painter", docs_url=None, redoc_url=None)
app.add_middleware(CORSMiddleware, allow_origins=ORIGINS, allow_methods=["GET"],
                   allow_headers=["*"])
P: Painter | None = None


async def loop():
    while True:
        t0 = time.time()
        end_ms = int(t0 * 1000) // WINDOW_MS * WINDOW_MS
        try:
            out = await asyncio.to_thread(P.window, end_ms)
        except Exception as e:                      # a bad window must not stop the painting
            print(f"window failed: {type(e).__name__}: {str(e)[:160]}", flush=True)
            out = None
        if out:
            print(f"canvas {P.canvas.id} strokes {P.canvas.n} (+{len(out['strokes'])}) "
                  f"colour {P.canvas.colour} block {P.frame['toBlock']} "
                  f"wall {time.time()-t0:.2f}s", flush=True)
            await publish("stroke", {"from": out["first"], "strokes": out["strokes"]})
            for b in out["brush"]:
                await publish("brush", b)
        await publish("state", P.state())
        await asyncio.sleep(max(1.0, WINDOW_MS / 1000.0 - (time.time() - t0)))


async def publish(event, data):
    dead = []
    for q in list(P.subs):
        try:
            q.put_nowait((event, data))
        except asyncio.QueueFull:
            dead.append(q)
    for q in dead:
        P.subs.discard(q)


@app.on_event("startup")
async def start():
    global P
    P = Painter()
    print(f"brain {P.brain.n:,} neurons; groups {P.group_sizes}; "
          f"canvas {P.canvas.id} at {P.canvas.n} strokes", flush=True)
    if os.environ.get("FLYO_AUTOSTART", "1") == "1":
        asyncio.create_task(loop())


@app.get("/health")
def health():
    return dict(ok=True, version=VERSION)


@app.get("/state")
def state():
    return JSONResponse(P.state())


@app.get("/strokes")
def strokes(start: int = Query(0, alias="from"), limit: int = 20000):
    rows = P.log.read(start, min(limit, 200000))
    return JSONResponse({"from": start, "next": start + len(rows), "strokes": rows})


@app.get("/canvas.png")
def canvas_png(scale: float = 1.0):
    img = C.render(P.log.read(0, 10_000_000), P.canvas.w, P.canvas.h,
                   scale=min(max(scale, 0.25), 2.0))
    import io
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    return Response(buf.getvalue(), media_type="image/png",
                    headers={"Cache-Control": "no-store"})


@app.get("/canvas/{cid}.png")
def frozen_png(cid: int):
    p = DATA / f"canvas-{int(cid):06d}.png"
    if not p.exists():
        return JSONResponse(dict(ok=False, error="no such frozen canvas"), status_code=404)
    return Response(p.read_bytes(), media_type="image/png")


@app.get("/manifest/{cid}.json")
def manifest(cid: int):
    p = DATA / f"canvas-{int(cid):06d}.json"
    if not p.exists():
        return JSONResponse(dict(ok=False, error="no such manifest"), status_code=404)
    return Response(p.read_text(), media_type="application/json")


@app.get("/stream")
async def stream():
    q: asyncio.Queue = asyncio.Queue(maxsize=64)
    P.subs.add(q)

    async def gen():
        try:
            yield f"event: state\ndata: {json.dumps(P.state())}\n\n"
            while True:
                try:
                    event, data = await asyncio.wait_for(q.get(), timeout=20.0)
                except asyncio.TimeoutError:
                    yield ": keepalive\n\n"
                    continue
                yield f"event: {event}\ndata: {json.dumps(data)}\n\n"
        finally:
            P.subs.discard(q)

    return StreamingResponse(gen(), media_type="text/event-stream",
                             headers={"Cache-Control": "no-store", "X-Accel-Buffering": "no"})
