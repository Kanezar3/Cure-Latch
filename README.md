# Cure Latch (`CureLatch`)

**Two-Round Bilateral Notice-of-Default & Affirmative Cure Latch on GenLayer**

`CureLatch` implements a statutory **Right-to-Cure** state machine (UCC § 2-508) for semiconductor wafer-lot fabrication covenants on GenLayer StudioNet ([`0x011aE1F6cec886202454b81e99fB87A7efa6020C`](https://explorer-studio.genlayer.com/address/0x011aE1F6cec886202454b81e99fB87A7efa6020C)).

Unlike single-round escrow contracts, `CureLatch` separates two **qualitatively different** AI consensus rounds:
1. **Round 1 (`adjudicate_defect_notice`) — Diagnostic Breach & Specificity:** Validators fetch commit-pinned metrology reports, verify SHA-256 integrity, and classify whether a concrete defect exists (`BREACH_LATCHED` -> latches `LITHOGRAPHY_OVERLAY`, `INTERCONNECT_SHORT`, or `THERMAL_DOPANT` and opens a timed cure window) or whether the lot meets spec (`REJECTED_NO_BREACH` -> slashes the frivolous buyer's ceiling-10% inspection stake to the supplier).
2. **Round 2 (`adjudicate_cure_tender`) — Causal Root-Cause Remediation & Non-Regression:** Only if Round 1 latched a breach may the supplier tender a **distinct** post-rework metrology report. Validators judge whether the remedy causally cured the exact Round 1 `latched_defect_domain` **without** introducing regressions in unaffected domains (`CURE_VERIFIED` vs `CURE_DEFICIENT`).

---

## Steward-Hardened Safety & Escrow Guarantees

- **Zero Stranded Native Value:** Payable `deposit_escrow()` (`@gl.public.write.payable`) credits isolated `pending_withdrawals[caller]` balances up front, while non-payable `open_covenant` / `file_defect_notice` validate inputs atomically before locking funds, and `withdraw_payout` transfers real native wei via `_EoaRecipient.emit_transfer`.
- **Retriable `UNVERIFIABLE` + Safe Unwind:** Transient fetch/parse/hash/ambiguous evaluations never consume the covenant or slash stakes (`MAX_EVAL_ATTEMPTS = 5`, with `unwind_unverifiable_covenant` no-fault refund).
- **Disjoint Compatibility Tables:** `ROUND1_COMPATIBLE_REASONS` and `ROUND2_COMPATIBLE_REASONS` enforced in `leader_fn`, `validator_fn`, and pre-storage assertions.
- **Strict Repository & Anti-Replay Binding:** Covenants freeze `canonical_repo_prefix`; both rounds require 40-hex commit-pinned URLs under that prefix, and Round 2 forbids replaying Round 1's evidence URL or hash (`REPLAYED_ROUND1_EVIDENCE`).
- **Fail-Closed Clock & Ceiling Stake:** Zero `time_offset` hooks; `_current_timestamp()` fails closed (`NO_BLOCK_TIME`), and minimum buyer stake uses ceiling math `max(10, (bond * 10 + 99) // 100)`.

---

## Live StudioNet Deployment & Verification

- **Contract Address:** [`0x011aE1F6cec886202454b81e99fB87A7efa6020C`](https://explorer-studio.genlayer.com/address/0x011aE1F6cec886202454b81e99fB87A7efa6020C)
- **Deployed Commit:** [`59726bdf2c530c0ec25e8681b44eaaef1ab15963`](https://github.com/Kanezar3/Cure-Latch/blob/59726bdf2c530c0ec25e8681b44eaaef1ab15963/contracts/cure_latch.py)
- **Git Blob SHA-1:** `91a3291ebf752b6a844d8961614ea53c35ad5b6b` (`deployed_source_byte_identical: true`, SHA-256 `28a3467b402b02676752dc336a41cbb7172ce8793c44f580e37a813a7dee819a`)
- **Runner:** `py-genlayer:1jb45aa8ynh2a9c9xn3b7qqh8sm5q93hwfp7jqmwsfhh8jpz09h6` (verified via [runner_probe.json](artifacts/runner_probe.json))
- **Release Manifest:** [release_manifest.json](release_manifest.json) (24 finalized StudioNet transactions: `DEPLOY`, `S0A`–`S11`, `X1`–`X8`; `total_deposited == total_withdrawn == 1320`, `contract_balance == 0`)

### Local Tests

```powershell
python -m pytest tests -v
```
All **10 / 10** unit and integration tests pass locally covering two-round cure verification, frivolous-claim stake slashing, cross-domain regression forfeiture, retriable `UNVERIFIABLE` + safe unwind, compatibility table enforcement, adversarial leader rejection, ceiling stake rounding, repo/anti-replay guards, fail-closed evidence/clock checks, and conservation invariants.
