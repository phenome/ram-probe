# ram-probe

Windows terminal monitor for memory, GPU pressure, and process usage. Built with Bun, TypeScript, and Rezi.

## Features

- Live RAM, commit, pagefile, kernel-pool, WDDM, DWM, and NVIDIA VRAM charts
- Executable and process rankings by memory, CPU, I/O, GPU allocation, or growth
- Linked, stable table selection across refreshes and ranking changes
- Warning and event view
- Rotating NDJSON logs in `logs/`, with recent-state restoration

## Run

Requires Windows, Bun, and PowerShell. NVIDIA metrics require `nvidia-smi`.

```bash
bun install
bun run start
```

Options:

```bash
bun run start --once   # collect one checkpoint, then exit
bun run start --fresh  # ignore restored history
```

Controls: `1`/`2`/`3` switch views, `w` changes graph window, `r` changes process ranking, `Space` freezes updates, `q` quits.

## Check

```bash
bun run check
bun test
```

Logs contain full process command lines. Keep `logs/` private.
