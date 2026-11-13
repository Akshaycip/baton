# Demo film

## The film

[`video/baton-demo.mp4`](../video/baton-demo.mp4): 1:34, 1920×1080, 30 fps, H.264 and AAC, -16 LUFS.

It was filmed in one take on NEAR testnet, against the deployed contracts and a live validator. The sale on screen is transaction [`BVSyLodDXPZQ3e7VNGSFw8TxhVesnNT6B8PP3SMCsLWp`](https://testnet.nearblocks.io/txns/BVSyLodDXPZQ3e7VNGSFw8TxhVesnNT6B8PP3SMCsLWp).

- The demo accounts sign without a wallet popup, so the film shows no wallet screens. The transactions are real.
- Maya and Sam are fictional. Their voices come from Orpheus, an open text-to-speech model, using its stock voices.
- The music is generated note by note in `tools/video/mix.py`, so there is nothing to license.
- In one shot the offer form above Sam's standing offer is covered, because it has nothing to do with that line.

## What it shows

The spoken words are in `tools/video/script.json`.

### 1. The problem

*Maya's stake, a note about the rent, and the table of what unstaking costs.*

**Maya:** I staked my savings with a small validator I really believe in.

**Maya:** Then my rent went up, and I needed that money today.

**Maya:** But unstaking takes more than a day. And my validator would lose the stake.

### 2. The idea

*The home page, and the NFT.*

**Narrator:** Baton turns a NEAR stake into an NFT you can sell.

**Narrator:** The NFT is a real NEAR account, staked with a real validator. Whoever holds the NFT owns the stake.

**Narrator:** When it changes hands, the stake keeps running. Only the holder changes.

### 3. See it work

*Sam's standing offer, the Exit now button, Maya's balance rising from 3.85 to 7.83 NEAR, the validator's total stake unchanged at 13,970,440.693 NEAR, and the chain of title.*

**Sam:** I keep some NEAR ready to buy stakes at a small discount. My offer just sits on chain, waiting.

**Maya:** So I pressed one button.

**Narrator:** One transaction. Maya has the money. Sam holds the stake, and it keeps earning.

**Narrator:** And look at the validator. Not one NEAR left.

### 4. Can the seller get back in?

*The holder room refusing Maya, the old API key returning 403, then Check it yourself with six green ticks.*

**Narrator:** So what stops a seller from keeping a way back in?

**Maya:** I tried. My private room is closed, and my old key is dead.

**Narrator:** Nobody can sign for this account at all. It has no keys. And anyone can check.

### 5. Why it matters

**Narrator:** This works with every validator on NEAR, today. No new token, no shared pool, and no change to NEAR.

**Sam:** I get paid to wait a day.

**Maya:** And I got out without hurting the validator I chose.

**End card:** Baton. Sell your NEAR stake without unstaking.

## How it was made

All in `tools/video/`, which has its own `package.json` so the product's install stays small.

1. `record.mjs` runs the app against testnet and drives Edge headless with playwright-core. It saves frames with timestamps and named marks.
2. `voices.py` speaks each line three times with Orpheus on the CPU.
3. `check.py` shortens long pauses, then transcribes every take with faster-whisper and scores it against the script. Speech-to-text catches wrong words but not how a voice sounds.
4. `compose.mjs` lays out the timeline from the chosen takes and renders an HTML stage frame by frame into ffmpeg. `mix.py` adds the music and sets the loudness.

## X post

> Unstaking NEAR takes up to 28 hours, and your validator loses the stake.
>
> Built at NEAR HACKATHON: Baton. Each NFT is its own NEAR account, staked with a real validator. Sell the NFT and the live stake moves in one transaction. Nothing unstakes.
>
> @NEARProtocol #NEARHackathon
