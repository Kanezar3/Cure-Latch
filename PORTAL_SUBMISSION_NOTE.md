# Portal Submission Note: Cure Latch

## 1. Portal Note (Under 1,000 Characters)

Cure Latch implements a two-round bilateral Right-to-Cure state machine (UCC 2-508) for wafer-lot fabrication covenants. Round 1 (adjudicate_defect_notice) judges commit-pinned metrology to latch a specific defect domain (LITHOGRAPHY_OVERLAY) or slash a frivolous buyer's ceiling-10% stake. Only after breach latch can Round 2 (adjudicate_cure_tender) evaluate distinct post-rework telemetry for causal remediation and zero collateral regression. UNVERIFIABLE stays retriable (max 5) with safe unwind; native wei escrow uses deposit_escrow and emit_transfer.

Live on StudioNet (0x011aE1F6cec886202454b81e99fB87A7efa6020C): Path A latched overlay breach and verified causal cure (supplier 950, buyer 260); Path B slashed frivolous stake (110). Blocked 8 abuses: zero escrow, sub-10% stake, /main/ URL, off-repo URL, unauthorized caller, premature cure, Round 1 replay, and Round 2 evidence replay. Caveat: StudioNet uses testnet wei via sim_fundAccount.

---

## 2. Evidence List

### Contract, Repo & Provenance
- **Explorer Contract**: https://explorer-studio.genlayer.com/address/0x011aE1F6cec886202454b81e99fB87A7efa6020C
- **Public GitHub Repo**: https://github.com/Kanezar3/Cure-Latch
- **Contract File (Pinned Commit `59726bdf2c530c0ec25e8681b44eaaef1ab15963`)**: https://github.com/Kanezar3/Cure-Latch/blob/59726bdf2c530c0ec25e8681b44eaaef1ab15963/contracts/cure_latch.py
- **Release Manifest**: https://github.com/Kanezar3/Cure-Latch/blob/main/release_manifest.json
- **Runner Probe Contract**: https://explorer-studio.genlayer.com/address/0xBF468F9D4ab40640F8Af807D5365514a3E76caaB

### Key Live Demo Transactions (`FINALIZED` + `MAJORITY_AGREE` + `SUCCESS`)
| Step | Action | Tx Link | Result |
|---|---|---|---|
| **DEPLOY** | Deploy `CureLatch` | https://explorer-studio.genlayer.com/tx/0xcd23cf68ed691f94c9bc86698fddbf47154863cbe7bb68a9b04a07c0ee31c01c | `FINALIZED` / `SUCCESS` |
| **S0A** | `deposit_escrow` (Supplier 1100) | https://explorer-studio.genlayer.com/tx/0x818bce49f256f59b824f9bcca1019ac47c1a0f43771661503ca77be87a564d0b | `1100` |
| **S0B** | `deposit_escrow` (Buyer 110) | https://explorer-studio.genlayer.com/tx/0x151c795da89498daaabcf854bbfa236219e3591667a9cafccb1deeb35026829e | `110` |
| **S1** | `open_covenant` (`cov_a1`) | https://explorer-studio.genlayer.com/tx/0x8d30881e28e74d4241e45a25b333e5f332c6aef4d009ab107c1b001e605ffd6d | `COVENANT_OPENED:cov_a1:REQ_STAKE_100` |
| **S2** | `file_defect_notice` (`cov_a1`) | https://explorer-studio.genlayer.com/tx/0x2fbeba43a2b21fa0f79cc71f2d573210ca0eb68a4019c8ccf5b464df72681eae | `NOTICE_FILED:cov_a1:STAKE_100` |
| **S3** | `adjudicate_defect_notice` (`cov_a1`) | https://explorer-studio.genlayer.com/tx/0xc5b03675d3353434410e109db981a72a3b69895ad53cd7198ad88ea273aebe53 | `ROUND1:cov_a1:BREACH_LATCHED:VERIFIED_OVERLAY_DEFECT` |
| **S4** | `submit_cure_tender` (`cov_a1`) | https://explorer-studio.genlayer.com/tx/0xd9f3b5b867d6d471e7582bd000b9a1a956a9a5f60392b1445b6c2f21e4763880 | `CURE_TENDERED:cov_a1` |
| **S5** | `adjudicate_cure_tender` (`cov_a1`) | https://explorer-studio.genlayer.com/tx/0xf2446b41e66de5494228d3cca9f9a9ad8297cf32e867934dad55532f4961f7d1 | `ROUND2:cov_a1:CURE_VERIFIED:CAUSAL_CURE_CONFIRMED` |
| **S6** | `withdraw_payout` (Supplier `950`) | https://explorer-studio.genlayer.com/tx/0x3722f6a8bebf11b60bb2ab3ed4fb566fbd0f6d73530bef258c1f902aa06be49f | `950` |
| **S7** | `withdraw_payout` (Buyer `260`) | https://explorer-studio.genlayer.com/tx/0xbc2abe4d5136d76c24bd40f4750ed90e95baa3a51294c950e377570ee3910e26 | `260` |
| **S10** | `adjudicate_defect_notice` (`cov_b2`) | https://explorer-studio.genlayer.com/tx/0x15ba54254ecf37d3aae30a35648633c0f3da267573779f568adbeb19e1b55642 | `ROUND1:cov_b2:REJECTED_NO_BREACH:LOT_WITHIN_TOLERANCE` |
| **S11** | `withdraw_payout` (Supplier `110`) | https://explorer-studio.genlayer.com/tx/0xdcd45af63581193a5da3527d6896f0d6f894d8e88de4f7703c799386ab5972ca | `110` |

### Expected Failures (`FINALIZED` + `MAJORITY_AGREE` + Leader `ERROR`)
| Step | Abuse Guard Triggered | Tx Link | Revert Code |
|---|---|---|---|
| **X1** | Zero escrow balance `open_covenant` | https://explorer-studio.genlayer.com/tx/0x9a7c54117b5961c57bee3aeb97a830cc04341c2a60bff0b3f9d6de061825da5d | `INSUFFICIENT_ESCROW_BALANCE` |
| **X2** | Sub-10% inspection stake (`99`) | https://explorer-studio.genlayer.com/tx/0x116ac749af4f79cb23e864b5ab248d68552652c4ea54013968f6907422c69d01 | `INSUFFICIENT_INSPECTION_STAKE` |
| **X3** | Unpinned `/main/` URL | https://explorer-studio.genlayer.com/tx/0x5341c7ceef197d40e5640ac288150706946698c723211143f0d95fb43c1d586c | `INVALID_EVIDENCE_URL` |
| **X4** | Off-repo URL prefix mismatch | https://explorer-studio.genlayer.com/tx/0x66c916ff86bba68a29bfb7dac230b61e8a812e0fa1f24a8b1c308466a5191aa4 | `REPO_PREFIX_MISMATCH` |
| **X5** | Unauthorized non-buyer notice | https://explorer-studio.genlayer.com/tx/0x93a92fde1c13413506673fe165202fe9c8294b5922168eb01ad31dbb477a9c37 | `UNAUTHORIZED_CALLER` |
| **X6** | Premature Round 2 cure tender | https://explorer-studio.genlayer.com/tx/0xe9eead3fc5925c4eec3b0633cdd25c59ab37964ee6dd498deb581a9892aecc42 | `INVALID_COVENANT_STATE` |
| **X7** | Replay Round 1 adjudication | https://explorer-studio.genlayer.com/tx/0x641409bee85cfa21257ffd2be78756a4d2848614aab253f025a736aa3cadedf2 | `ROUND1_ALREADY_CONCLUDED` |
| **X8** | Replay Round 1 evidence in Round 2 | https://explorer-studio.genlayer.com/tx/0x945d08edb6c4d9a42adf591e82bd186b3924338b9d8f06155af8c6f1b4545276 | `REPLAYED_ROUND1_EVIDENCE` |
