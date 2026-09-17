"""
Robinhood Chain reader: chain 4663, a block every ~0.1 s.

Eight channels, and the choice of which chain signal drives which sensory group is not
arbitrary. Each group was driven alone at its max rate and the roamer's motor readout was
measured (scratchpad steer_test, 2026-09-17), so the pairing puts steady signals on gentle
groups and rare ones on the violent groups:

  channel     signal                                 sensory group           measured dx, dy
  traffic     transactions in the window             labellar bristle        +1.2, +2.1
  senders     fees paid per sender, capped           Johnston's organ A      +0.4, +3.6
  gas         median effective gas price             thermosensory (TRN)     -4.0, -1.0
  equities    GOOGL transfer volume                  ventral ORNs            -0.4, -1.6
  launches    new coins on the pons factory          taste peg               +0.8, +0.4
  whales      native transfers >= 0.1                JO wind/gravity         -1.2, +12.6
  fly.buy     FLYBRAIN out of the v4 pool            pharyngeal sensillum    +2.0, +1.8
  fly.sell    FLYBRAIN into the v4 pool              putative ppk23         -19.2, +17.8
  fly.burn    FLYBRAIN to 0x...dEaD                  ORN_DA1 (cVA)           +0.4, +0.2

Two things to be honest about: fly.sell is an order of magnitude louder than anything else,
so once the coin trades the pen mostly follows selling; and the gate below scores every
channel against its OWN rolling median, so a channel only speaks when it is unusual for
itself, which is what keeps a busy chain from pinning the pen.

$FLYBRAIN graduated to a Uniswap v4 pool (phase 2, paired with GOOGL), and v4 keeps every
pool's tokens in one singleton, so "bought" and "sold" mean moved out of or into the
PoolManager. Reads only; nothing here signs.
"""
import json
import os
import random
import threading
import time
import urllib.error
import urllib.request
from collections import deque

import numpy as np
from eth_hash.auto import keccak

DEFAULT_RPC = "https://rpc.mainnet.chain.robinhood.com"
FALLBACK_RPC = "https://robinhood-rpc.publicnode.com"
CHAIN_ID = 4663

FLYBRAIN = "0x4eb990547bce4a982432ca88cf5fae7eed1a2d35"
GOOGL = "0x2e0847e8910a9732eb3fb1bb4b70a580adad4fe3"     # FLYBRAIN's pair token
POOL_MANAGER = "0x8366a39cc670b4001a1121b8f6a443a643e40951"   # Uniswap v4 singleton
FACTORY = "0x7ed598bcef8bd9edd8c97a195c6d13f40801ec7e"        # pons v2 launch factory
DEAD = "0x000000000000000000000000000000000000dead"

WHALE_WEI = int(0.1e18)      # a "whale" transaction carries at least this much native value
MIN_TOKENS = 1.0             # ignore dust transfers
CAP_FRAC = 0.02
CAP_FLOOR = {"senders": 0.002, "equities": 1_000.0,
             "fly.buy": 100_000.0, "fly.sell": 100_000.0, "fly.burn": 100_000.0}
MAD_FLOOR = {"gas": 0.002, "whales": 1.0, "launches": 1.0}

GATING = dict(Z_GATE=2.0, R_MIN=10.0, K=10.0, MAX_HZ=80.0, BUF=360, WARM=30)

# Per-channel ceiling, from the arcfly calibration of the same groups (GAIN 0.15).
MAX_HZ = {"traffic": 80.0, "senders": 80.0, "gas": 60.0, "equities": 10.0,
          "launches": 80.0, "whales": 80.0, "fly.buy": 80.0, "fly.sell": 80.0,
          "fly.burn": 40.0}

# channel -> the selector that resolves its neuron group in the connectome
GROUPS = {
    "traffic": {"subclass": "labellar bristle"},
    "senders": {"dictionary": "JO_A"},
    "gas": {"type_re": "^TRN_"},
    "equities": {"type_re": "^ORN_V.+"},
    "launches": {"subclass": "taste peg"},
    "whales": {"subclass": "wind_gravity"},
    "fly.buy": {"subclass": "pharyngeal sensillum"},
    "fly.sell": {"receptor": "^putative_ppk23$"},
    "fly.burn": {"dictionary": "ORN_DA1"},
}
IDS = list(GROUPS)

MAX_LOGS = 2000


def topic(sig):
    return "0x" + keccak(sig.encode()).hex()


T_TRANSFER = topic("Transfer(address,address,uint256)")
T_LAUNCHED = topic("TokenLaunched(address,address,address,address,uint256,uint256)")


def _addr(t):
    return "0x" + t[-40:].lower()


def _words(data):
    d = data[2:] if data.startswith("0x") else data
    return [d[i:i + 64] for i in range(0, len(d), 64)]


def _hexint(x):
    return int(x, 16) if isinstance(x, str) else int(x)


class RpcError(Exception):
    pass


class Rpc:
    """Endpoint rotation with backoff. A User-Agent is always sent: public RPCs reject the
    default urllib one."""

    def __init__(self, urls=None, timeout=15.0):
        urls = urls or [os.environ.get("FLYO_RPC") or DEFAULT_RPC, FALLBACK_RPC]
        self.urls = [u for u in dict.fromkeys(urls) if u]
        self.bad_until = {u: 0.0 for u in self.urls}
        self.fails = {u: 0 for u in self.urls}
        self.timeout = timeout
        self.lock = threading.Lock()
        self.last_ok = 0.0
        self._id = 0

    def _post(self, url, payload):
        req = urllib.request.Request(url, data=json.dumps(payload).encode(),
                                     headers={"Content-Type": "application/json",
                                              "User-Agent": "flyonardo-painter/1"})
        with urllib.request.urlopen(req, timeout=self.timeout) as r:
            return json.loads(r.read())

    def _order(self):
        now = time.time()
        return [u for u in self.urls if self.bad_until[u] <= now] or self.urls[:1]

    def request(self, payload):
        last = None
        for url in self._order():
            try:
                out = self._post(url, payload)
                self.fails[url] = 0
                self.last_ok = time.time()
                return out
            except (urllib.error.URLError, TimeoutError, OSError, ValueError) as e:
                last = e
                with self.lock:
                    self.fails[url] += 1
                    self.bad_until[url] = time.time() + min(
                        120.0, 2.0 ** self.fails[url]) * (0.8 + 0.4 * random.random())
        raise RpcError(f"all endpoints failed: {type(last).__name__}: {str(last)[:160]}")

    def call(self, method, params):
        self._id += 1
        out = self.request({"jsonrpc": "2.0", "id": self._id, "method": method, "params": params})
        if isinstance(out, dict) and "error" in out:
            raise RpcError(str(out["error"])[:200])
        return out["result"]

    def batch(self, calls):
        payload = [{"jsonrpc": "2.0", "id": i, "method": m, "params": p}
                   for i, (m, p) in enumerate(calls)]
        out = self.request(payload)
        if not isinstance(out, list):
            raise RpcError("batch not supported")
        by = {o.get("id"): o for o in out}
        res = []
        for i in range(len(calls)):
            o = by.get(i)
            if o is None or "error" in o:
                raise RpcError(f"batch item {i} failed")
            res.append(o["result"])
        return res


# ---- gating (median/MAD against a channel's own history) ---------------------------

def median_mad(buf, cid):
    if not len(buf):
        return 0.0, max(MAD_FLOOR.get(cid, 0.0), 1e-9)
    a = np.asarray(buf, dtype=np.float64)
    med = float(np.median(a))
    mad = 1.4826 * float(np.median(np.abs(a - med)))
    return med, max(mad, MAD_FLOOR.get(cid) or 1e-9 * max(1.0, med))


def gate(x, buf, cid, max_hz, g=GATING):
    med, mad = median_mad(buf, cid)
    z = (x - med) / mad
    warm = len(buf) < g["WARM"]
    if warm or z < g["Z_GATE"]:
        return z, 0.0, warm
    return z, float(min(max_hz, g["R_MIN"] + g["K"] * (z - g["Z_GATE"]))), warm


def cap_sum(per_key, cap):
    total, capped = 0.0, 0
    for v in per_key.values():
        total += min(v, cap)
        capped += v > cap
    return total, int(capped)


class Gates:
    def __init__(self, ids=IDS, max_hz=None, g=GATING):
        self.g = g
        self.max_hz = dict(max_hz or MAX_HZ)
        self.bufs = {i: deque(maxlen=g["BUF"]) for i in ids}

    def cap_for(self, cid, floor):
        b = self.bufs[cid]
        return max(CAP_FRAC * (float(np.median(b)) if len(b) else 0.0), floor)

    def step(self, raw):
        out = {}
        for i, buf in self.bufs.items():
            x = float(raw.get(i, 0.0))
            z, rate, warm = gate(x, buf, i, self.max_hz.get(i, self.g["MAX_HZ"]), self.g)
            buf.append(x)
            out[i] = dict(raw=x, z=round(float(z), 3), rate_hz=round(rate, 2), warm=warm)
        return out

    def dump(self):
        return {i: list(b) for i, b in self.bufs.items()}

    def load(self, d):
        for i, v in (d or {}).items():
            if i in self.bufs:
                self.bufs[i].extend(float(x) for x in v)


# ---- window ------------------------------------------------------------------------

class Cursor:
    """Blocks are ~0.1 s, so a 12 s window is ~120 of them. Timestamps are whole seconds
    and many blocks share one; that only means they land in the same window."""

    def __init__(self, rpc, lag=4, max_blocks=400):
        self.rpc = rpc
        self.lag = lag
        self.max_blocks = max_blocks
        self.next_block = None
        self.head = None

    def window(self, end_ms):
        self.head = _hexint(self.rpc.call("eth_blockNumber", []))
        safe = self.head - self.lag
        gap = False
        if self.next_block is None:
            self.next_block = safe - 120
            gap = True
        if safe - self.next_block + 1 > self.max_blocks:
            self.next_block = safe - self.max_blocks + 1
            gap = True
        if safe < self.next_block:
            return [], gap
        nums = list(range(self.next_block, safe + 1))
        hs = []
        for i in range(0, len(nums), 100):
            hs += [h for h in self.rpc.batch(
                [("eth_getBlockByNumber", [hex(n), True]) for n in nums[i:i + 100]]) if h]
        hs.sort(key=lambda h: _hexint(h["number"]))
        take = [h for h in hs if _hexint(h["timestamp"]) * 1000 < end_ms]
        if take:
            self.next_block = _hexint(take[-1]["number"]) + 1
        return take, gap


def _get_logs(rpc, lo, hi, params, depth=0):
    p = dict(params, fromBlock=hex(lo), toBlock=hex(hi))
    try:
        out = rpc.call("eth_getLogs", [p])
        if len(out) < MAX_LOGS or lo == hi:
            return out
    except RpcError:
        if lo == hi or depth > 8:
            raise
    mid = (lo + hi) // 2
    return _get_logs(rpc, lo, mid, params, depth + 1) + _get_logs(rpc, mid + 1, hi, params, depth + 1)


def fetch_logs(rpc, lo, hi):
    return _get_logs(rpc, lo, hi, {"address": [FLYBRAIN, GOOGL, FACTORY],
                                   "topics": [[T_TRANSFER, T_LAUNCHED]]})


def sample_receipts(rpc, blocks, k=3):
    if not blocks:
        return {}
    idx = sorted(set(int(round(x)) for x in np.linspace(0, len(blocks) - 1, min(k, len(blocks)))))
    out = {}
    for i in idx:
        n = _hexint(blocks[i]["number"])
        try:
            out[n] = rpc.call("eth_getBlockReceipts", [hex(n)]) or []
        except Exception:
            pass
    return out


def extract(blocks, receipts, logs, gates):
    """Raw channel values for one window. Blocks are full (transactions included)."""
    raw = {i: 0.0 for i in IDS}
    capped = {i: 0 for i in IDS}
    raw["traffic"] = float(sum(len(b["transactions"]) for b in blocks))

    whales = set()
    for b in blocks:
        for t in b["transactions"]:
            if _hexint(t.get("value") or "0x0") >= WHALE_WEI:
                whales.add(t["from"].lower())
    raw["whales"] = float(len(whales))

    fee_by_sender, prices = {}, []
    for rs in receipts.values():
        for r in rs:
            price = _hexint(r.get("effectiveGasPrice") or "0x0")
            if price == 0:
                continue
            prices.append(price / 1e9)
            s = r["from"].lower()
            fee_by_sender[s] = fee_by_sender.get(s, 0.0) + price * _hexint(r["gasUsed"]) / 1e18
    if receipts:
        total, capped["senders"] = cap_sum(fee_by_sender, gates.cap_for("senders", CAP_FLOOR["senders"]))
        raw["senders"] = total * (len(blocks) / max(1, len(receipts)))
        raw["gas"] = float(np.median(prices)) if prices else 0.0

    eq, buys, sells, burns = {}, {}, {}, {}
    launches = 0
    for lg in logs:
        a = lg["address"].lower()
        t = lg["topics"]
        if not t:
            continue
        t0 = t[0].lower()
        if t0 == T_LAUNCHED and a == FACTORY:
            launches += 1
            continue
        if t0 != T_TRANSFER or len(t) < 3:
            continue
        w = _words(lg["data"])
        if not w:
            continue
        frm, to = _addr(t[1]), _addr(t[2])
        amt = int(w[0], 16) / 1e18
        if amt < MIN_TOKENS:
            continue
        if a == GOOGL:
            eq[frm] = eq.get(frm, 0.0) + amt
        elif a == FLYBRAIN:
            if to == DEAD:
                burns[frm] = burns.get(frm, 0.0) + amt
            elif frm == POOL_MANAGER and to != POOL_MANAGER:
                buys[to] = buys.get(to, 0.0) + amt
            elif to == POOL_MANAGER and frm != POOL_MANAGER:
                sells[frm] = sells.get(frm, 0.0) + amt
    raw["launches"] = float(launches)
    for cid, d in (("equities", eq), ("fly.buy", buys), ("fly.sell", sells), ("fly.burn", burns)):
        raw[cid], capped[cid] = cap_sum(d, gates.cap_for(cid, CAP_FLOOR[cid]))
    return raw, capped


def read_window(rpc, cursor, gates, end_ms):
    """One window: (frame, rates) or (None, None) when no new blocks have landed."""
    blocks, gap = cursor.window(end_ms)
    if not blocks:
        return None, None
    lo, hi = _hexint(blocks[0]["number"]), _hexint(blocks[-1]["number"])
    receipts = sample_receipts(rpc, blocks)
    logs = fetch_logs(rpc, lo, hi)
    raw, capped = extract(blocks, receipts, logs, gates)
    gated = gates.step(raw)
    frame = dict(fromBlock=lo, toBlock=hi, blocks=len(blocks), gap=gap,
                 headHash=blocks[-1]["hash"], headBlock=hi,
                 logs=len(logs), sampled=len(receipts),
                 raw=raw, capped=capped, gated=gated,
                 warm=any(v["warm"] for v in gated.values()),
                 # the brush walks these in order, so a window's colour changes are spread
                 # across the blocks that actually happened rather than all on the head
                 blockList=[dict(n=_hexint(b["number"]), hash=b["hash"]) for b in blocks])
    return frame, {i: gated[i]["rate_hz"] for i in IDS}
