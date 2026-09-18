"""
The painter's on-chain half: commit the growing canvas, notice when one is claimed.

Two jobs, both small:

  COMMIT   Every `FLYO_COMMIT_S` seconds the operator writes (strokeRoot, inputHash,
           strokes) for the live canvas. That is what a claim freezes, so the picture is
           pinned before anyone claims it. Robinhood Chain gas is ~0.055 gwei and a commit
           is ~43k gas, which is ~0.0000024 native each - but at one every 12 s that is
           still ~0.017 a day, so the default interval is 120 s. The operator wallet's
           balance is reported in /state; when it runs dry the painting carries on and only
           the commits stop, which is the right way round.

  WATCH    `currentCanvas()` is one eth_call. When the contract's id runs ahead of the
           painter's, somebody claimed: read the frozen record, freeze the same canvas
           locally, and start a blank one. Polling a single view beats scanning logs - no
           log-range limits, no reorg handling (and this chain has none), and it cannot
           miss a claim because the id only moves forward.

Nothing here decides what gets drawn. If the chain is unreachable the painter keeps
painting and simply has nothing pinned for that stretch.
"""
import json
import os
import time

from eth_hash.auto import keccak

import rh


def sel(sig):
    return keccak(sig.encode())[:4].hex()


SEL = {
    "commit": sel("commit(uint64,bytes32,bytes32,uint32)"),
    "currentCanvas": sel("currentCanvas()"),
    "current": sel("current()"),
    "price": sel("price()"),
    "operator": sel("operator()"),
    "token": sel("token()"),
    "canvasOf": sel("canvasOf(uint64)"),
}
T_CLAIMED = rh.topic("Claimed(uint64,address,uint256,bytes32,bytes32,uint32,uint32,uint64)")


def _word(x):
    if isinstance(x, bytes):
        return x.rjust(32, b"\x00").hex()
    if isinstance(x, str):
        return x.lower().replace("0x", "").rjust(64, "0")
    return format(int(x) & (1 << 256) - 1, "064x")


class OnChain:
    """Reads always; writes only when an operator key is configured."""

    def __init__(self, rpc, address=None, key=None, commit_s=None):
        self.rpc = rpc
        self.address = (address or os.environ.get("FLYO_CONTRACT") or "").strip().lower() or None
        self.commit_s = float(commit_s or os.environ.get("FLYO_COMMIT_S") or 120)
        self._key = (key or os.environ.get("FLYO_OPERATOR_KEY") or "").strip() or None
        self.operator = None
        self.last_commit = None
        self.last_commit_at = 0.0
        self.balance = None
        self.price = None
        self.off_reason = None
        if self._key:
            from eth_account import Account
            self.operator = Account.from_key(self._key).address
        if not self.address:
            self.off_reason = "no contract configured"
        elif not self._key:
            self.off_reason = "no operator key: reading only"

    @property
    def writing(self):
        return bool(self.address and self._key)

    # ---- reads --------------------------------------------------------------------

    def call(self, data):
        return self.rpc.call("eth_call", [{"to": self.address, "data": "0x" + data}, "latest"])

    def current_id(self):
        r = self.call(SEL["currentCanvas"])
        return int(r, 16) if r and r != "0x" else None

    def read_price(self):
        r = self.call(SEL["price"])
        self.price = int(r, 16) if r and r != "0x" else None
        return self.price

    def read_operator(self):
        r = self.call(SEL["operator"])
        return "0x" + r[-40:] if r and len(r) >= 42 else None

    def read_balance(self):
        if not self.operator:
            return None
        r = self.rpc.call("eth_getBalance", [self.operator, "latest"])
        self.balance = int(r, 16) / 1e18 if r else None
        return self.balance

    def frozen(self, canvas_id):
        """The claimed record, decoded loosely: (claimer, strokes, burned, root)."""
        r = self.call(SEL["canvasOf"] + _word(canvas_id))
        if not r or r == "0x":
            return None
        w = [r[2:][i:i + 64] for i in range(0, len(r) - 2, 64)]
        if len(w) < 10:
            return None
        return dict(strokeRoot="0x" + w[0], inputHash="0x" + w[1],
                    strokes=int(w[2], 16), commits=int(w[3], 16),
                    commitBlock=int(w[4], 16), commitTime=int(w[5], 16),
                    claimBlock=int(w[6], 16), claimTime=int(w[7], 16),
                    claimer="0x" + w[8][-40:], burned=int(w[9], 16) / 1e18)

    def claim_tx(self, canvas_id, claim_time):
        """The claim's transaction hash, for a link on the site. Best effort.

        The contract's claimBlock is useless for this: on a Nitro chain `block.number` is
        the Ethereum L1 block, not this chain's. So the L2 block is estimated from the
        claim timestamp at the measured ~0.1 s a block and a window around it is searched.
        """
        try:
            head = self.rpc.call("eth_getBlockByNumber", ["latest", False])
            hn, ht = int(head["number"], 16), int(head["timestamp"], 16)
            est = hn - int((ht - int(claim_time)) / 0.1)
            logs = rh._get_logs(self.rpc, max(0, est - 6000), min(hn, est + 6000),
                                {"address": self.address,
                                 "topics": [T_CLAIMED, "0x" + _word(canvas_id)]})
            return logs[-1]["transactionHash"] if logs else None
        except Exception:
            return None

    # ---- the one write ------------------------------------------------------------

    def commit(self, canvas_id, stroke_root, input_hash, strokes):
        """Returns the tx hash, or None when writing is off or the interval has not passed."""
        if not self.writing or time.time() - self.last_commit_at < self.commit_s:
            return None
        from eth_account import Account
        data = ("0x" + SEL["commit"] + _word(canvas_id) + _word(stroke_root)
                + _word(input_hash) + _word(strokes))
        nonce = int(self.rpc.call("eth_getTransactionCount", [self.operator, "pending"]), 16)
        gas_price = max(int(self.rpc.call("eth_gasPrice", []), 16) * 2, 100_000_000)
        # eth_call is happy with a lowercase address; the signer is not - it refuses a `to`
        # that is not checksummed, which is what stopped every commit on the first night.
        from eth_utils import to_checksum_address
        tx = dict(nonce=nonce, gasPrice=gas_price, gas=120_000,
                  to=to_checksum_address(self.address), value=0,
                  data=data, chainId=rh.CHAIN_ID)
        raw = Account.sign_transaction(tx, self._key).raw_transaction
        h = self.rpc.call("eth_sendRawTransaction", ["0x" + raw.hex().removeprefix("0x")])
        self.last_commit_at = time.time()
        self.last_commit = dict(canvasId=int(canvas_id), strokeRoot=stroke_root,
                                inputHash=input_hash, strokes=int(strokes),
                                tx=h, at=int(time.time()),
                                costNative=round(120_000 * gas_price / 1e18, 9))
        return h

    def state(self):
        return dict(contract=self.address, operator=self.operator,
                    writing=self.writing, offReason=self.off_reason,
                    commitEverySeconds=self.commit_s,
                    operatorBalance=None if self.balance is None else round(self.balance, 6),
                    price=None if self.price is None else str(self.price),
                    priceRaw=None if self.price is None else str(self.price),
                    priceDisplay=None if self.price is None else round(self.price / 1e18, 4),
                    lastCommit=self.last_commit)
