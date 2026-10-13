# Holdfast — Spesifikasi Teknis untuk Implementasi

Dokumen ini dikirim bersama `holdfast-launchpad.html` (prototipe UI final).
Prototipe = acuan **tampilan dan alur**. Dokumen ini = acuan **logika, arsitektur, dan aturan**.
Jika ada yang bertentangan, ikuti dokumen ini untuk logika dan prototipe untuk tampilan.

---

## 1. Ringkasan produk

Holdfast adalah launchpad memecoin di atas **pump.fun (Solana)**. Bedanya dengan pump.fun biasa:

1. **Creator fee tidak masuk ke dev.** Fee setiap coin dikirim ke vault on-chain milik coin itu, yang tidak punya fungsi withdraw.
2. **Floor otomatis.** Saat harga turun sampai floor, vault membeli coin tersebut (buyback).
3. **Holder dibayar berdasarkan lama hold.** Setiap 2 menit holder menerima SOL dan token hasil buyback. Semakin lama hold, semakin besar bagiannya.

Target pengguna: trader memecoin Solana. Nilai jualnya: coin yang "membela harganya sendiri" dan "membayar yang setia".

---

## 2. Aturan mekanisme (wajib persis)

| Aturan | Nilai |
|---|---|
| Split creator fee | **60%** Floor vault · **30%** Holder payout · **10%** buy & burn $HOLD |
| Bagian dev/launcher | **0%**, terkunci di program |
| Floor | `floor = ATH × (1 − trigger)` |
| Pilihan trigger | 15%, 25% (default), 35%. Dipilih saat launch dan **tidak bisa diubah** |
| Floor ikut ATH | Ya, floor naik saat ATH naik dan tidak pernah turun |
| Kondisi buyback | Harga ≤ floor |
| Ukuran buyback | 10% saldo SOL floor vault per langkah, dengan cooldown antar langkah (lihat §7) |
| Token hasil buyback | **Tidak di-burn.** Masuk ke pool payout berikutnya dan dibagi ke holder sesuai weight |
| Interval payout | Setiap 2 menit |
| Rumus share holder | `share_i = (tokens_i × weight_i) / Σ(tokens × weight)` |
| Rumus weight | `weight = 0.1 + 0.9 × min(jam_hold, 168) / 168` (0.1× saat beli, 1.0× setelah 7 hari) |
| Jual sebagian | Token yang tersisa mempertahankan umur (weight) lot-nya |
| Jual semua | Semua lot hilang, sehingga pembelian berikutnya mulai dari 0.1× |
| Tidak dihitung | Dev buy saat launch, token yang diterima via transfer, pool/program/akun non-wallet |
| Biaya launch | 0.015 SOL (network + akun). User mengirim SOL ke deposit address, tanpa connect wallet. Sisa SOL dikembalikan |

### Pelacakan umur hold (lot-based, FIFO)
- Setiap **buy swap** yang valid membuat satu *lot*: `{wallet, mint, amount, acquired_at}`.
- Setiap **sell** atau **transfer keluar** mengurangi lot dengan urutan **FIFO** (lot terlama berkurang lebih dulu). Pilihan FIFO wajib dikonfirmasi ke owner, karena LIFO lebih menguntungkan holder lama.
- Token yang **diterima via transfer** tidak membuat lot, sehingga tidak menghasilkan payout.
- `weight` dihitung per lot, lalu dijumlahkan per wallet: `Σ(lot.amount × weight(lot.age))`.

---

## 3. Arsitektur

```
                ┌──────────────┐
  pump.fun /    │  Indexer     │  parse tx buy/sell/transfer → lots, harga, ATH
  PumpSwap ───► │ (Helius/Yell-│──────────────┐
                │  owstone)    │              ▼
                └──────────────┘        ┌───────────┐      ┌────────────┐
                                        │ Postgres  │◄────►│  API       │◄──► Frontend (Next.js)
  ┌──────────────────────┐              └───────────┘      └────────────┘
  │ Holdfast Vault       │◄──── Keeper (crank): collect fee, update ATH,
  │ Program (Anchor)     │      defend (buyback), payout round, burn $HOLD
  └──────────────────────┘
```

Komponen:
1. **Vault Program (Anchor, Rust)**: menyimpan SOL dan token per coin. Tidak ada instruksi withdraw.
2. **Keeper / crank (TypeScript)**: memanggil instruksi program secara berkala.
3. **Indexer**: mendengarkan transaksi semua mint Holdfast, mengisi tabel lot, trade, harga, dan ATH.
4. **Payout worker**: tiap 2 menit menghitung share, membuat snapshot round, lalu memanggil `payout`.
5. **API**: REST/WebSocket untuk frontend.
6. **Frontend**: Next.js + Tailwind, tampilan mengikuti prototipe.

---

## 4. On-chain program (Anchor)

### Accounts
- `Config` (global): admin, `hold_mint`, keeper authority, parameter global (cooldown, max steps per jam).
- `CoinVault` (PDA per mint, seed `["vault", mint]`):
  - `mint`, `trigger_bps` (1500/2500/3500, **immutable**), `ath_price`, `floor_price`
  - `floor_sol`, `holder_sol`, `burn_sol` (saldo per bucket)
  - `holder_tokens` (token hasil buyback yang menunggu dibagikan)
  - `last_defend_ts`, `defend_count`, `round_id`
- Vault token account (ATA milik PDA) untuk token hasil buyback.

### Instruksi
| Instruksi | Siapa | Fungsi |
|---|---|---|
| `init_coin(mint, trigger_bps)` | launcher flow | Membuat `CoinVault`. `trigger_bps` hanya boleh 1500/2500/3500 |
| `collect_fees` | keeper | Klaim creator fee pump.fun/PumpSwap ke PDA, lalu bagi 60/30/10 ke bucket |
| `update_ath` | keeper | Baca harga langsung dari reserve bonding curve / pool PumpSwap. `ath = max(ath, harga_TWAP)` |
| `defend` | siapa pun (permissionless) | Jika `harga ≤ floor` dan cooldown lewat: swap 10% `floor_sol` → token (CPI ke pump/PumpSwap, wajib `min_out`) → `holder_tokens` |
| `payout(round_id, recipients[], sol[], tokens[])` | keeper | Transfer ke wallet biasa saja. Total tidak boleh melebihi pot round. Satu round bisa dipecah ke beberapa tx |
| `burn_hold` | keeper | Swap `burn_sol` → $HOLD, lalu burn di transaksi yang sama |

**Invarian yang wajib ada di program:**
- Tidak ada jalur SOL keluar selain `defend` (ke pool swap), `payout` (ke wallet biasa), dan `burn_hold`.
- `payout` per round tidak boleh melebihi pot yang di-snapshot di awal round.
- `trigger_bps` dan alamat `hold_mint` tidak bisa diubah setelah di-set.

---

## 5. Off-chain

### Tabel database (minimal)
- `coins` (mint, name, ticker, image_url, description, socials, trigger_bps, creator, created_at)
- `trades` (sig, mint, wallet, side, sol, tokens, price, ts, source: curve|pumpswap|vault)
- `lots` (id, wallet, mint, amount_remaining, acquired_at)
- `price_candles` (mint, tf, open, high, low, close, volume, ts)
- `vault_state` (mint, floor_sol, holder_sol, burn_sol, holder_tokens, ath, floor, updated_at)
- `defends` (sig, mint, sol_spent, tokens_bought, price, ts)
- `payout_rounds` (round_id, mint, sol_pot, token_pot, snapshot_hash, ts)
- `payouts` (round_id, wallet, mint, sol, tokens, sig)

### Payout round (tiap 2 menit, per coin)
1. Snapshot pot: `holder_sol` dan `holder_tokens` saat ini.
2. Hitung `Σ(lot × weight)` per wallet yang eligible.
3. Hitung bagian tiap wallet. Bagian di bawah minimum (dust) **dibawa ke round berikutnya**, tidak hilang.
4. Wallet tanpa SOL: tunggu sampai bagiannya cukup untuk rent minimum.
5. Simpan snapshot (daftar wallet + share + hash) secara **publik**, supaya siapa pun bisa memverifikasi round.
6. Panggil `payout` (batch beberapa tx bila perlu).

### Launch flow (tanpa connect wallet)
1. User mengisi form, lalu backend membuat deposit address unik.
2. Watcher mendeteksi deposit ≥ 0.015 SOL (+ dev buy jika ada).
3. Backend membuat coin di pump.fun dengan **creator = PDA vault**, memanggil `init_coin`, lalu mengeksekusi dev buy.
4. Sisa SOL dikembalikan ke wallet pengirim.
5. Frontend menampilkan "Deposit received", lalu redirect ke halaman coin. Alur ini sudah ada di prototipe.

---

## 6. Frontend (mengikuti prototipe)

| Halaman | Isi | Data dari API |
|---|---|---|
| Coins `/` | 4 kartu stat, filter (Newest, Trending, Vault buying, Top payouts, Biggest vault), search, toggle grid/table | `/stats`, `/coins?sort=&q=` |
| Coin `/coin/[mint]` | Header, market cap + bar floor→ATH, candlestick 1m/5m/15m/1h dengan garis floor dan penanda "V", tab Trades/Holders/Vault buys, panel Buy/Sell, Floor vault, Your share, Top holders by weight | `/coins/[mint]`, `/candles`, WS `trades`, `/holders`, `/me/position` |
| Create `/create` | Form, upload gambar, pilihan floor, preview, modal deposit QR | `POST /launch`, WS `deposit-status` |
| Profile `/profile` | Total earned, posisi per coin, weight | `/me` |
| Modal How it works | Teks 5 langkah, sama seperti prototipe | — |

Catatan UI:
- Gambar coin di prototipe adalah maskot SVG placeholder. Di production, pakai gambar upload user. Maskot dipakai hanya sebagai fallback jika coin tidak punya gambar.
- Countdown payout di sidebar harus tersinkron dengan jadwal round dari server.
- Tombol trade: ikuti flow pump.fun (wallet adapter Phantom/Solflare dan lain-lain) untuk buy/sell.

---

## 7. Keamanan dan risiko (harus ditangani)

1. **Manipulasi ATH untuk mengosongkan vault.** Penyerang bisa mem-pump harga sesaat agar ATH dan floor naik, lalu dump supaya vault membeli di harga tinggi. Mitigasi:
   - ATH dihitung dari **TWAP** (misalnya rata-rata 5–15 menit), bukan harga spot satu transaksi.
   - Ada cooldown antar `defend` dan batas jumlah langkah per jam.
   - Opsional: floor hanya naik jika ATH baru bertahan selama N menit.
2. **Sandwich pada buyback.** Wajib memakai `min_out`/slippage ketat. Pertimbangkan Jito bundle dan waktu eksekusi yang diacak.
3. **Kepercayaan pada off-chain.** Penentuan siapa yang menerima payout dilakukan off-chain. Publikasikan snapshot tiap round agar bisa diaudit, dan pertimbangkan Merkle root on-chain di tahap berikutnya.
4. **Sybil dan wash trading** untuk mengakali weight. Weight hanya naik seiring waktu, jadi efeknya terbatas. Tetap pantau.
5. **Audit program** wajib sebelum mainnet karena program ini menyimpan dana pengguna.
6. Fitur bagi hasil ke holder bisa punya implikasi regulasi di beberapa yurisdiksi. Konsultasikan dengan penasihat hukum sebelum launch.

---

## 8. Yang harus diverifikasi lebih dulu

Mekanisme pump.fun bisa berubah, jadi cek dokumentasi dan program terbarunya:
- Apakah creator/creator-fee recipient sebuah coin bisa di-set ke **PDA program**, dan bagaimana cara mengklaim fee (curve dan PumpSwap setelah graduation).
- Instruksi dan account untuk CPI buy di bonding curve dan di PumpSwap.
- Cara membaca harga langsung dari reserve curve/pool on-chain.

Referensi pembanding: routeanchor.fun memakai pola serupa (fee diarahkan ke vault program tanpa withdraw, payout tiap 2 menit), jadi pendekatan ini terbukti bisa dijalankan.

---

## 9. Urutan pengerjaan

1. **Riset dan PoC:** verifikasi §8, lalu buat coin di devnet dengan creator = PDA dan klaim fee.
2. **Program vault** + unit test (invarian §4) di devnet.
3. **Indexer** + tabel `trades`, `lots`, dan candles.
4. **Keeper:** collect_fees, update_ath (TWAP), defend, burn_hold.
5. **Payout worker** + snapshot publik.
6. **Frontend** sesuai prototipe, terhubung ke API dan WS.
7. **Launch flow** dengan deposit address.
8. Audit, beta tertutup, lalu mainnet.

## 10. Kriteria selesai (acceptance)

- [ ] Coin baru bisa di-launch hanya dengan mengirim SOL, dan fee mengalir ke vault PDA.
- [ ] Split 60/30/10 terbukti benar di on-chain.
- [ ] Tidak ada cara menarik SOL dari vault selain tiga jalur yang diizinkan (dibuktikan dengan test).
- [ ] Harga ≤ floor memicu buyback 10%, cooldown berjalan, dan token masuk ke pool holder.
- [ ] Payout tiap 2 menit sesuai rumus weight, dan snapshot bisa diverifikasi ulang.
- [ ] Dev buy dan token hasil transfer tidak mendapat payout.
- [ ] Tampilan desktop dan mobile sama dengan prototipe.
