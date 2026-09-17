"""
From descending neurons to a pen stroke.

The first version of this file read the roamer's command cells - DNa02 left minus right for
turning, DNa01 for forward, MDN for backward, DNp09 for stop. Measured against the chain
channels it barely drew: those groups are ONE CELL PER SIDE in this connectome, so over a
control step a cell either spikes or does not, and 236 of 240 steps produced no stroke at
all (scratchpad paint_smoke, 2026-09-17). Lengthening the step did not help - it averaged
the same few spikes into a smaller number.

So this reads the whole descending population instead, which is the same argument
`decoder.py` in the main repo makes for the vision task: the directional signal is spread
across the population rather than concentrated in one pair of cells. Measured over 100 ms
steps, every single step carries a signal, and the size of it tracks the chain:

    chain quiet    138 Hz summed across 11 active descending neurons
    chain typical  9,866 Hz across 206
    chain loud    15,930 Hz across 252

The fly turns and walks rather than sliding in x and y, because that is what a walking fly
does and because it draws curves instead of a staircase:

    imbalance = (right rates - left rates) / (right + left)
    turn      = (imbalance - its own running mean) * TURN_DEG     degrees this step
    speed     = clip(population rate / POP_FULL, 0, 1) * SPEED_PX  pixels this step
    heading  += turn,   pen moves SPEED along heading

Turning on the *change* in imbalance, not its absolute value, is deliberate and is the same
move the input gate makes: this population sits at a standing rightward bias (+0.09 to
+0.50 depending on the drive), so using the raw value would spiral the pen in circles
forever. Against its own running mean, a steady bias draws a straight line and a SHIFT in
the balance is what turns the pen.

Disclosed choices, all here in one place: TURN_DEG, SPEED_PX, POP_FULL and the baseline
half-life. The connectome decides what the numbers are; these four decide how big a mark
they make.
"""
import numpy as np
import pandas as pd

TURN_DEG = 300.0      # degrees per unit of imbalance change
SPEED_PX = 40.0       # pixels per step at full descending drive
POP_FULL = 12000.0    # summed descending Hz counted as "full drive" (typical window ~10k)
BASE_HALFLIFE = 12.0  # steps; how fast the turn baseline follows the standing bias
CEILING = 450.0       # the model's refractory ceiling, for the command-cell overlay


class Motor:
    def __init__(self, fb, annotations, turn_deg=TURN_DEG, speed_px=SPEED_PX,
                 pop_full=POP_FULL):
        self.fb = fb
        self.turn_deg, self.speed_px, self.pop_full = float(turn_deg), float(speed_px), float(pop_full)
        ann = pd.read_feather(annotations, columns=["bodyId", "somaSide", "rootSide"])
        ann = ann.drop_duplicates("bodyId").set_index("bodyId")
        side = ann["somaSide"].fillna(ann["rootSide"]).reindex(fb.bodies).fillna("") \
            .to_numpy().astype(str)

        dns = fb.where(superclass="descending_neuron")
        self.groups = {
            "dn_L": np.array([i for i in dns if side[i] == "L"], dtype=np.int64),
            "dn_R": np.array([i for i in dns if side[i] == "R"], dtype=np.int64),
            "dn_all": np.asarray(dns, dtype=np.int64),
            # the named command cells are still read, so the site can show what the
            # documented steering and stopping neurons were doing while the pen moved
            "steer_L": self._side(fb, side, "DNa02", "L"),
            "steer_R": self._side(fb, side, "DNa02", "R"),
            "fwd": fb.where(type_re="^DNa01$"),
            "back": fb.where(type_re="^MDN$"),
            "stop": fb.where(type_re="^DNp09$"),
        }
        self.sizes = {k: int(len(v)) for k, v in self.groups.items()}
        for k in ("dn_L", "dn_R", "dn_all", "back", "stop"):
            if not len(self.groups[k]):
                raise RuntimeError(f"motor group {k} missing from the connectome")
        self.base = None        # running mean of the imbalance
        self.alpha = 1.0 - 0.5 ** (1.0 / BASE_HALFLIFE)

    @staticmethod
    def _side(fb, side, t, s):
        return np.array([i for i in fb.where(type_re=rf"^{t}$") if side[i] == s], dtype=np.int64)

    def state(self):
        return dict(base=None if self.base is None else float(self.base))

    def load(self, st):
        b = (st or {}).get("base")
        self.base = None if b is None else float(b)

    def readout(self, rates):
        """(turn_degrees, speed_px, detail) for one control step."""
        hzL, hzR = float(np.sum(rates["dn_L"])), float(np.sum(rates["dn_R"]))
        tot = hzL + hzR
        imb = (hzR - hzL) / tot if tot > 0 else 0.0
        if self.base is None:
            self.base = imb                      # first step sets the baseline, no lurch
        dev = imb - self.base
        self.base += self.alpha * dev

        stop = float(np.mean(rates["stop"])) / CEILING if len(rates["stop"]) else 0.0
        back = float(np.mean(rates["back"])) / CEILING if len(rates["back"]) else 0.0
        fwd = float(np.mean(rates["fwd"])) / CEILING if len(rates["fwd"]) else 0.0

        speed = min(tot / self.pop_full, 1.0) * self.speed_px
        speed *= 1.0 - min(max(stop, 0.0), 1.0)          # DNp09 brakes the pen
        if back > fwd:                                    # Moonwalker wins: the fly backs up
            speed = -speed
        turn = float(np.clip(dev, -1.0, 1.0)) * self.turn_deg
        return turn, speed, dict(
            popHz=round(tot, 1), activeDn=int(np.count_nonzero(rates["dn_all"])),
            imbalance=round(imb, 4), baseline=round(self.base, 4), turn=round(turn, 2),
            speed=round(speed, 2),
            command=dict(steer_L=round(float(np.mean(rates["steer_L"])), 1) if len(rates["steer_L"]) else 0.0,
                         steer_R=round(float(np.mean(rates["steer_R"])), 1) if len(rates["steer_R"]) else 0.0,
                         fwd=round(fwd * CEILING, 1), back=round(back * CEILING, 1),
                         stop=round(stop * CEILING, 1)))
