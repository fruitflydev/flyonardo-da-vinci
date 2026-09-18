# Flyonardo da Vinci

A fruit fly draws, and Robinhood Chain moves its brain.

The real male CNS connectome — 165,122 neurons, about 10.2 million connections — runs
off-chain on a CPU as leaky integrate-and-fire units. Live Robinhood Chain activity drives
named groups of its sensory cells; its descending neurons steer a pen across a canvas; the
line it leaves is the drawing. A canvas grows until somebody claims it as an NFT by burning
$FLYBRAIN, and then a blank one starts.

Nobody steers it. There is no random walk, no smoothing toward anything pretty, and no
human input at any point. Quiet stretches of chain produce quiet, jittery marks, and they
stay in the picture.

What it is not: it does not run on-chain, it is not conscious, and it is not an uploaded
fly. The mapping from chain signals to senses is a choice we made and disclose, not biology
— a fly has never sensed a blockchain.

## Live

- Canvas and claim: **https://flybrain.online/flyonardo** (part of the $FLYBRAIN project)
- Painter API: `/state`, `/strokes?from=`, `/canvas.png`, `/stream` (SSE)
- Contract: [`0x04c154478D5ad851E6083661462B3001C30D6D3E`](https://robinhoodchain.blockscout.com/address/0x04c154478D5ad851E6083661462B3001C30D6D3E)
  on Robinhood Chain (4663) — ERC-721, 100,000 $FLYBRAIN a canvas, price adjustable by the owner
- Burn token: [$FLYBRAIN `0x4eb9…2d35`](https://robinhoodchain.blockscout.com/token/0x4eb990547bce4a982432ca88cf5fae7eed1a2d35)

## How a stroke happens

Every 12 s window the painter reads the chain, scores each channel against **its own**
rolling median (so a channel only speaks when it is unusual for itself), drives the matching
sensory groups at the resulting rates, and runs the brain forward in ten 100 ms control
steps. Each step gives one stroke.

**The pen turns and walks** rather than sliding in x and y, because that is what a walking
fly does and because it draws curves instead of a staircase:

```
imbalance = (right descending rates - left descending rates) / (right + left)
turn      = (imbalance - its own running mean) * 300 degrees
speed     = clip(population rate / 12000 Hz, 0, 1) * 40 px
heading  += turn,  pen moves speed along heading
```

Turning on the *change* in imbalance is deliberate: this population sits at a standing
rightward bias, so the raw value would spiral the pen in circles forever.

### Why the whole population, not the command cells

The first version read the roamer's command neurons — DNa02 left minus right to steer,
DNa01 forward, MDN back, DNp09 stop. Measured against real chain drive it barely drew:
those groups are **one cell per side** in this connectome, so in a control step a cell
either spikes or it does not, and **236 of 240 steps produced no stroke at all**.
Lengthening the step only averaged the same few spikes into a smaller number.

Reading all 1,314 descending neurons instead — the same argument `decoder.py` makes in the
main repo for the vision task — gives a signal on every single step, and its size tracks
the chain:

| chain | summed descending rate | active descending neurons |
|---|---|---|
| quiet | 138 Hz | 11 of 1,314 |
| typical | 9,866 Hz | 206 |
| loud | 15,930 Hz | 252 |

The command cells are still recorded and published in `/state`, so you can see what the
documented steering and stopping neurons were doing while the pen moved.

## The brush

Four primaries on warm paper. Robinhood Chain makes a block every **~0.1 s**, roughly fifty
times faster than the fly can put ink down, so "one block, one colour" would change the
brush several times between strokes and no colour would ever be visible. Instead:

- the brush advances at the **first new block after the fly has drawn 120 px of line**, so
  every colour is guaranteed a visible run and a busy chain cannot shred the drawing;
- **which** colour comes next is taken from that block's hash, mapped onto the three colours
  that are not current — always a visible change, always chain-derived, reproducible by
  anyone replaying the chain;
- a fly that stops holds one colour instead of strobing.

Band length therefore reads the fly's speed, while the colour and the moment are the
chain's.

### Line weight

Each stroke is 1 to 6 px wide, and the width is **how much of the whole brain fired on that
step**, ranked against the last 240 steps. The pen's direction and speed come from the
descending neurons; line weight is deliberately a different reading, so it says something
the path does not: a stroke is heavy when far more of the brain was awake than it has been
lately, and a hairline when it was nearly silent. It is a rank rather than a fixed scale for
the same reason the chain channels are gated against their own history — a fixed scale sits
at one end on a loud day and the other on a quiet one.

The width is part of the packed stroke, so it is part of the root: the line weight is pinned
on chain along with the path. Because a root is a rolling hash, a canvas cannot change
format half way, so formats are fixed per canvas — canvases started before widths existed
are format 1 (`<HHHHB`, every stroke drawn at 2 px), and every canvas after is format 2
(`<HHHHBB`, the last byte is the width). A canvas's manifest says which it is.

## Channels

Each chain signal drives one sensory group. The pairing is not arbitrary: every group was
driven alone at its calibrated rate and the resulting pen movement measured first, so steady
signals sit on gentle groups and rare ones on the violent groups.

| channel | signal | sensory group | measured dx, dy |
|---|---|---|---|
| `traffic` | transactions in the window | labellar bristle | +1.2, +2.1 |
| `senders` | fees paid per sender, capped | Johnston's organ A | +0.4, +3.6 |
| `gas` | median effective gas price | thermosensory (TRN) | −4.0, −1.0 |
| `equities` | GOOGL transfer volume | ventral ORNs | −0.4, −1.6 |
| `launches` | new coins on the pons factory | taste peg | +0.8, +0.4 |
| `whales` | native transfers ≥ 0.1 | JO wind/gravity | −1.2, +12.6 |
| `fly.buy` | FLYBRAIN out of the v4 pool | pharyngeal sensillum | +2.0, +1.8 |
| `fly.sell` | FLYBRAIN into the v4 pool | putative ppk23 | −19.2, +17.8 |
| `fly.burn` | FLYBRAIN to `0x…dEaD` | ORN_DA1 (cVA) | +0.4, +0.2 |

Two things to be honest about: **`fly.sell` is an order of magnitude louder than anything
else**, so once the coin trades the pen mostly follows selling; and MDN (backward walking)
outfires DNa01 under several channels, so those inputs walk the fly backwards — the same
asymmetry the plume experiment in the main repo found. Nothing compensates for either.

$FLYBRAIN graduated to a Uniswap v4 pool paired with GOOGL, and v4 keeps every pool's
tokens in one singleton, so "bought" and "sold" mean moved out of or into the PoolManager.

## Claiming

Every couple of minutes the operator commits `(strokeRoot, inputHash, strokes)` for the
live canvas. `claim(canvasId, maxBurn)` burns the price in $FLYBRAIN to `0x…dEaD`, mints
canvas `canvasId` to the caller, and freezes it **at the last committed values** — the
picture is pinned before the claim, never chosen after it. `canvasId` must be the canvas you
were shown, so a claim cannot race ahead of one that came first, and `maxBurn` means a price
change can never overcharge a pending transaction.

The stroke log is hashed as it grows: `strokeRoot = sha256(previous root || packed stroke)`
from 32 zero bytes, strokes packed as `<HHHHB` (x0, y0, x1, y1, colour). Anyone can redraw a
canvas from its log and check the root.

## Layout

| path | what |
|---|---|
| `painter/` | the service: `rh.py` (chain reader and gating), `motor.py` (descending population to turn and speed), `canvas.py` (canvas, brush, stroke log, PNG), `onchain.py` (commits and claim watching), `service.py` (loop and API) |
| `contracts/` | `FlyonardoCanvas.sol` (ERC-721, hand-written, no dependencies), 39 tests, deploy and set-price scripts |

The site lives in the main project's site repo, as a page on flybrain.online.

## Tests

```
cd contracts && npm ci && npx hardhat test     # 39 tests, in-memory chain
```

Deploy scripts refuse chain 4663 unless `CONFIRM_MAINNET=yes`.

## Credits and licences

- Our code: MIT, see `LICENSE`.
- Connectome: MaleCNS v1.0, Janelia Research Campus FlyEM and Google, CC BY 4.0. The data
  files are not in this repo.
- Neuron model after Shiu et al. 2024 (Nature); the motor mapping and its limits are
  documented in `painter/motor.py`.
