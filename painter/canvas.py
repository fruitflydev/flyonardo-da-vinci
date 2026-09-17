"""
The canvas, the brush, and the stroke log.

The fly walks and leaves a line. Two clocks decide what that line looks like, and keeping
them separate is the whole design:

  the FLY decides WHERE the line goes    - turn and speed from its descending population
  the CHAIN decides WHICH COLOUR and WHEN - the next block after enough ink has gone down

Robinhood Chain makes a block every ~0.1 s, about fifty times faster than the fly can put
ink on paper. "One block, one colour" would therefore change the brush several times
between strokes and no colour would ever be visible as a stroke - the line would read as
confetti. So the brush is DISTANCE-GATED: it advances at the first new block after the fly
has drawn at least `brush_px` of line since the last change. Every colour is guaranteed a
visible run, a busy chain cannot shred the drawing, and a fly that stops holds one colour
instead of strobing.

Which of the four colours comes next is taken from that block's hash, mapped onto the three
colours that are not current, so the change is always visible, always chain-derived, and
anyone replaying the chain gets the same sequence. It is not a round-robin we chose.

The stroke log is hashed as it grows: strokeRoot = sha256(previous root || packed stroke).
That root is what gets committed on-chain each window and frozen when a canvas is claimed,
so the picture is pinned before anyone claims it rather than chosen afterwards.
"""
import hashlib
import json
import math
import struct
from pathlib import Path

# Four primaries on warm paper. The paper is not a colour the fly can draw with.
PAPER = "#f4f1ea"
PALETTE = ("#d92b32", "#f0c020", "#2f6fe0", "#1f9e57")   # red, yellow, blue, green

W, H = 1600, 1000
BRUSH_PX = 120.0          # ink a colour must lay down before the chain may change it
EDGE = 6                  # keep the pen this far inside the paper

STROKE = struct.Struct("<HHHHB")     # x0, y0, x1, y1, colour
ZERO_ROOT = bytes(32)


class Canvas:
    """One canvas: the fly's position, the line so far, and the rolling root."""

    def __init__(self, canvas_id, w=W, h=H, brush_px=BRUSH_PX, state=None):
        self.id = int(canvas_id)
        self.w, self.h = int(w), int(h)
        self.brush_px = float(brush_px)
        if state:
            self.x, self.y = float(state["x"]), float(state["y"])
            self.heading = float(state.get("heading", 0.0))
            self.colour = int(state["colour"])
            self.ink = float(state["ink"])
            self.n = int(state["n"])
            self.root = bytes.fromhex(state["root"])
            self.brush_changes = int(state.get("brush_changes", 0))
            self.last_brush_block = int(state.get("last_brush_block", 0))
            self.distance = float(state.get("distance", 0.0))
        else:
            self.x, self.y = self.w / 2.0, self.h / 2.0
            self.heading = 0.0
            self.colour = 0
            self.ink = 0.0                 # ink laid down since the last brush change
            self.n = 0                     # strokes
            self.root = ZERO_ROOT
            self.brush_changes = 0
            self.last_brush_block = 0
            self.distance = 0.0            # total line length, all colours

    # ---- drawing ------------------------------------------------------------------

    def step(self, turn_deg, speed_px):
        """
        Turn the fly by `turn_deg`, walk it `speed_px` along its new heading, and return
        the stroke it left, or None if it did not move.

        A walking fly turns and then walks; it does not slide sideways. Steering the
        heading rather than the pixel offsets is what makes the line curve instead of
        climbing a staircase.

        At the edges the heading reflects rather than clamping: a fly pinned against a
        wall would draw one thick border and nothing else. The reflection is our
        convention, not the fly's - disclosed for that reason.
        """
        self.heading = (self.heading + float(turn_deg)) % 360.0
        th = math.radians(self.heading)
        x0, y0 = self.x, self.y
        x1 = x0 + float(speed_px) * math.cos(th)
        y1 = y0 + float(speed_px) * math.sin(th)
        if x1 < EDGE or x1 > self.w - EDGE:
            self.heading = (180.0 - self.heading) % 360.0
            th = math.radians(self.heading)
            x1 = x0 + float(speed_px) * math.cos(th)
            y1 = y0 + float(speed_px) * math.sin(th)
        if y1 < EDGE or y1 > self.h - EDGE:
            self.heading = (-self.heading) % 360.0
            th = math.radians(self.heading)
            x1 = x0 + float(speed_px) * math.cos(th)
            y1 = y0 + float(speed_px) * math.sin(th)
        x1 = min(max(x1, EDGE), self.w - EDGE)
        y1 = min(max(y1, EDGE), self.h - EDGE)

        seg = ((x1 - x0) ** 2 + (y1 - y0) ** 2) ** 0.5
        if seg < 0.5:                       # a still fly leaves no stroke, and no colour change
            self.x, self.y = x1, y1
            return None

        self.x, self.y = x1, y1
        self.ink += seg
        self.distance += seg
        self.n += 1
        stroke = (int(round(x0)), int(round(y0)), int(round(x1)), int(round(y1)), self.colour)
        self.root = hashlib.sha256(self.root + STROKE.pack(*stroke)).digest()
        return stroke

    def maybe_change_brush(self, block_number, block_hash):
        """
        The chain's half of the deal. Returns the new colour index, or None.

        Called with the newest block of the window. It only fires once the fly has drawn
        `brush_px` of line, so the colour cadence follows the drawing, not the block rate,
        while the chain still chooses the colour and the moment.
        """
        if self.ink < self.brush_px or int(block_number) <= self.last_brush_block:
            return None
        h = int(block_hash, 16) if isinstance(block_hash, str) else int(block_hash)
        self.colour = (self.colour + 1 + (h % 3)) % len(PALETTE)
        self.ink = 0.0
        self.brush_changes += 1
        self.last_brush_block = int(block_number)
        return self.colour

    # ---- persistence --------------------------------------------------------------

    def state(self):
        return dict(id=self.id, x=self.x, y=self.y, heading=self.heading,
                    colour=self.colour, ink=self.ink,
                    n=self.n, root=self.root.hex(), brush_changes=self.brush_changes,
                    last_brush_block=self.last_brush_block, distance=self.distance,
                    w=self.w, h=self.h, brush_px=self.brush_px)


class Log:
    """Append-only stroke log on disk, one canvas per file, packed 9 bytes a stroke."""

    def __init__(self, dir_path, canvas_id):
        self.dir = Path(dir_path)
        self.dir.mkdir(parents=True, exist_ok=True)
        self.path = self.dir / f"canvas-{int(canvas_id):06d}.strokes"
        self.f = open(self.path, "ab")

    def append(self, strokes):
        if not strokes:
            return
        self.f.write(b"".join(STROKE.pack(*s) for s in strokes))
        self.f.flush()

    def read(self, start=0, limit=20000):
        """Strokes [start, start+limit) as plain lists, for the site to draw."""
        size = STROKE.size
        with open(self.path, "rb") as f:
            f.seek(int(start) * size)
            buf = f.read(int(limit) * size)
        return [list(STROKE.unpack_from(buf, i)) for i in range(0, len(buf) - size + 1, size)]

    def count(self):
        return self.path.stat().st_size // STROKE.size if self.path.exists() else 0

    def close(self):
        try:
            self.f.close()
        except Exception:
            pass


def root_of(path):
    """Recompute the root of a stroke file from scratch - the check anyone else can run."""
    root = ZERO_ROOT
    size = STROKE.size
    with open(path, "rb") as f:
        while True:
            b = f.read(size * 4096)
            if not b:
                break
            for i in range(0, len(b) - size + 1, size):
                root = hashlib.sha256(root + b[i:i + size]).digest()
    return root


def render(strokes, w=W, h=H, scale=1.0, width=2):
    """PNG of a stroke list. Pillow only; the site draws the live line itself."""
    from PIL import Image, ImageDraw
    img = Image.new("RGB", (int(w * scale), int(h * scale)), PAPER)
    d = ImageDraw.Draw(img)
    lw = max(1, int(round(width * scale)))
    for x0, y0, x1, y1, c in strokes:
        d.line([(x0 * scale, y0 * scale), (x1 * scale, y1 * scale)],
               fill=PALETTE[int(c) % len(PALETTE)], width=lw)
    return img


def write_manifest(path, canvas, inputs_hash, block, extra=None):
    """What a claimed canvas is: its root, the inputs that made it, and how to redraw it."""
    m = dict(canvas=canvas.state(), inputHash=inputs_hash, block=int(block),
             palette=list(PALETTE), paper=PAPER, strokeFormat="<HHHHB x0 y0 x1 y1 colour",
             rootRule="sha256(previous root || packed stroke), from 32 zero bytes")
    m.update(extra or {})
    Path(path).write_text(json.dumps(m, indent=1))
    return m
