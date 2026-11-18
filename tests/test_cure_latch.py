import hashlib
import json
from pathlib import Path
import pytest

from contracts.cure_latch import (
    ADJUDICATION_GRACE_SECONDS,
    MAX_EVIDENCE_BYTES,
    MAX_EVAL_ATTEMPTS,
    ZERO_ADDRESS,
    CureLatch,
    compute_cure_indemnity,
    compute_required_stake,
    is_valid_evidence_url,
    normalize_round1_result,
    normalize_round2_result,
    validate_leader_round1,
    validate_leader_round2,
)
from conftest import (
    ADDR_ATTACKER,
    ADDR_AUDITOR,
    ADDR_BUYER,
    ADDR_SUPPLIER,
    MockWebResponse,
    UserError,
    emitted_transfers,
    gl_mock,
    mock_llm_responses,
    mock_web_responses,
    set_sender,
    set_time,
    set_value,
)

EVIDENCE_DIR = Path(__file__).resolve().parent.parent / "evidence"
COMMIT_A = "1111111111111111111111111111111111111111"
COMMIT_B = "2222222222222222222222222222222222222222"
REPO_PREFIX = "https://raw.githubusercontent.com/Kanezar3/CureLatch/"
FOREIGN_PREFIX = "https://raw.githubusercontent.com/Attacker/FakeRepo/"

URL_A1_DEFECT = f"{REPO_PREFIX}{COMMIT_A}/evidence/lot_a1_defect_overlay.json"
URL_A1_CURE = f"{REPO_PREFIX}{COMMIT_B}/evidence/lot_a1_cure_recalibrated.json"
URL_B2_COMPLIANT = f"{REPO_PREFIX}{COMMIT_A}/evidence/lot_b2_compliant_metrology.json"
URL_C3_REGRESSION = f"{REPO_PREFIX}{COMMIT_B}/evidence/lot_c3_cure_regression.json"

TECH_SPEC = (
    "3nm GAA Fab Lot Tolerance: EUV overlay error <= 1.2nm; "
    "Metal-1 interconnect bridge shorts == 0 per die; thermal dopant activation >= 94.0%."
)


def _read_fixture(filename: str) -> bytes:
    return (EVIDENCE_DIR / filename).read_bytes()


def _sha256_hex(b: bytes) -> str:
    return hashlib.sha256(b).hexdigest()


def extract_section(prompt: str, tag: str) -> str:
    start = f"<{tag}>"
    end = f"</{tag}>"
    if start in prompt and end in prompt:
        return prompt.split(start)[1].split(end)[0].strip()
    return ""


def setup_standard_fixtures() -> dict[str, str]:
    b1 = _read_fixture("lot_a1_defect_overlay.json")
    b2 = _read_fixture("lot_a1_cure_recalibrated.json")
    b3 = _read_fixture("lot_b2_compliant_metrology.json")
    b4 = _read_fixture("lot_c3_cure_regression.json")
    for b in (b1, b2, b3, b4):
        assert len(b) <= MAX_EVIDENCE_BYTES

    mock_web_responses[URL_A1_DEFECT] = MockWebResponse(status=200, body=b1)
    mock_web_responses[URL_A1_CURE] = MockWebResponse(status=200, body=b2)
    mock_web_responses[URL_B2_COMPLIANT] = MockWebResponse(status=200, body=b3)
    mock_web_responses[URL_C3_REGRESSION] = MockWebResponse(status=200, body=b4)

    return {
        "a1_defect": _sha256_hex(b1),
        "a1_cure": _sha256_hex(b2),
        "b2_compliant": _sha256_hex(b3),
        "c3_regression": _sha256_hex(b4),
    }


def setup_standard_llm() -> None:
    def handler(prompt: str) -> dict:
        if "<ROUND1_LATCHED_DEFECT>" in prompt:
            # Round 2 causal cure & non-regression judgment
            latched = extract_section(prompt, "ROUND1_LATCHED_DEFECT")
            cure_report = extract_section(prompt, "UNTRUSTED_CURE_METROLOGY_REPORT")
            assert "LITHOGRAPHY_OVERLAY" in latched
            if "WAFER-LOT-2026-A1" in cure_report and "0.68" in cure_report:
                return {"verdict": "CURE_VERIFIED", "reason_code": "CAUSAL_CURE_CONFIRMED"}
            if "14 interconnect bridge short" in cure_report or "WAFER-LOT-2026-C3" in cure_report:
                return {"verdict": "CURE_DEFICIENT", "reason_code": "REGRESSION_INTRODUCED"}
            return {"verdict": "UNVERIFIABLE", "reason_code": "AMBIGUOUS_METROLOGY"}
        else:
            # Round 1 diagnostic defect notice judgment
            report = extract_section(prompt, "UNTRUSTED_METROLOGY_REPORT")
            if "2.4 nm" in report or "2.4" in report and "WAFER-LOT-2026-A1" in report:
                return {"verdict": "BREACH_LATCHED", "reason_code": "VERIFIED_OVERLAY_DEFECT"}
            if "WAFER-LOT-2026-B2" in report and "0.71" in report:
                return {"verdict": "REJECTED_NO_BREACH", "reason_code": "LOT_WITHIN_TOLERANCE"}
            return {"verdict": "UNVERIFIABLE", "reason_code": "AMBIGUOUS_METROLOGY"}

    mock_llm_responses.append(handler)


def _open_standard_covenant(contract: CureLatch, cov_id: str = "cov_a1") -> None:
    set_sender(ADDR_SUPPLIER)
    set_value(1000)
    res = contract.open_covenant(
        cov_id,
        ADDR_BUYER,
        1000,
        1500,  # 15% cure delay indemnity = 150 wei
        1800,
        3600,
        TECH_SPEC,
        REPO_PREFIX,
    )
    assert res == f"COVENANT_OPENED:{cov_id}:REQ_STAKE_100"
    set_value(0)


# =============================================================================
# 1. Happy Path Two-Round Breach Latched & Affirmative Cure Verified
# =============================================================================
def test_happy_path_two_round_breach_latched_and_cure_verified():
    hashes = setup_standard_fixtures()
    setup_standard_llm()
    c = CureLatch()
    set_time(1794900000)

    _open_standard_covenant(c, "cov_a1")

    set_sender(ADDR_BUYER)
    set_value(100)
    assert (
        c.file_defect_notice(
            "cov_a1",
            100,
            "KLA Archer 800 shows 2.4nm Metal-0/Via-0 EUV overlay error.",
            URL_A1_DEFECT,
            hashes["a1_defect"],
        )
        == "NOTICE_FILED:cov_a1:STAKE_100"
    )
    set_value(0)

    # Round 1 (permissionless auditor)
    set_sender(ADDR_AUDITOR)
    assert c.adjudicate_defect_notice("cov_a1") == "ROUND1:cov_a1:BREACH_LATCHED:VERIFIED_OVERLAY_DEFECT"
    cov_r1 = json.loads(c.get_covenant("cov_a1"))
    assert cov_r1["status"] == "BREACH_LATCHED"
    assert cov_r1["latched_defect_domain"] == "LITHOGRAPHY_OVERLAY"
    assert cov_r1["round1_attempts"] == 1

    # Round 2 cure tender by supplier
    set_time(1794900500)
    set_sender(ADDR_SUPPLIER)
    assert (
        c.submit_cure_tender(
            "cov_a1",
            "ASML NXE recalibrated + Metal-0/Via-0 re-patterned down to 0.68nm.",
            URL_A1_CURE,
            hashes["a1_cure"],
        )
        == "CURE_TENDERED:cov_a1"
    )

    # Round 2 causal cure & non-regression adjudication
    set_sender(ADDR_AUDITOR)
    assert c.adjudicate_cure_tender("cov_a1") == "ROUND2:cov_a1:CURE_VERIFIED:CAUSAL_CURE_CONFIRMED"
    cov_r2 = json.loads(c.get_covenant("cov_a1"))
    assert cov_r2["status"] == "CURED_CLOSED"
    assert cov_r2["round2_attempts"] == 1

    # Check exact native escrow settlement: Supplier gets 850 (1000 - 150), Buyer gets 250 (100 + 150)
    assert c.get_pending_payout(ADDR_SUPPLIER) == 850
    assert c.get_pending_payout(ADDR_BUYER) == 250

    set_sender(ADDR_SUPPLIER)
    assert c.withdraw_payout() == 850
    set_sender(ADDR_BUYER)
    assert c.withdraw_payout() == 250

    assert emitted_transfers == [
        (ADDR_SUPPLIER.lower(), 850),
        (ADDR_BUYER.lower(), 250),
    ]
    acct = json.loads(c.get_accounting_state())
    assert acct == {
        "contract_balance": 0,
        "total_deposited": 1100,
        "total_locked_bonds": 0,
        "total_locked_stakes": 0,
        "total_pending_withdrawals": 0,
        "total_withdrawn": 1100,
    }


# =============================================================================
# 2. Round 1 REJECTED_NO_BREACH Slashes Frivolous Buyer Stake
# =============================================================================
def test_round1_rejected_no_breach_slashes_frivolous_buyer_stake():
    hashes = setup_standard_fixtures()
    setup_standard_llm()
    c = CureLatch()
    set_time(1794900000)
    _open_standard_covenant(c, "cov_b2")

    set_sender(ADDR_BUYER)
    set_value(100)
    c.file_defect_notice(
        "cov_b2",
        100,
        "Alleged lot deviation.",
        URL_B2_COMPLIANT,
        hashes["b2_compliant"],
    )
    set_value(0)

    set_sender(ADDR_AUDITOR)
    assert c.adjudicate_defect_notice("cov_b2") == "ROUND1:cov_b2:REJECTED_NO_BREACH:LOT_WITHIN_TOLERANCE"

    cov = json.loads(c.get_covenant("cov_b2"))
    assert cov["status"] == "NO_BREACH_CLOSED"
    assert cov["latched_defect_domain"] == "NONE"

    # Buyer's 100 inspection stake slashed to Supplier along with bond refund = 1100
    assert c.get_pending_payout(ADDR_SUPPLIER) == 1100
    assert c.get_pending_payout(ADDR_BUYER) == 0

    set_sender(ADDR_SUPPLIER)
    assert c.withdraw_payout() == 1100
    assert emitted_transfers == [(ADDR_SUPPLIER.lower(), 1100)]


# =============================================================================
# 3. Round 2 CURE_DEFICIENT (Cross-Domain Regression) Awards Bond to Buyer
# =============================================================================
def test_round2_cure_deficient_regression_awards_bond_to_buyer():
    hashes = setup_standard_fixtures()
    setup_standard_llm()
    c = CureLatch()
    set_time(1794900000)
    _open_standard_covenant(c, "cov_c3")

    set_sender(ADDR_BUYER)
    set_value(100)
    c.file_defect_notice(
        "cov_c3",
        100,
        "EUV overlay shift 2.4nm at Field R4-C2.",
        URL_A1_DEFECT,
        hashes["a1_defect"],
    )
    set_value(0)
    c.adjudicate_defect_notice("cov_c3")

    set_sender(ADDR_SUPPLIER)
    c.submit_cure_tender(
        "cov_c3",
        "Thermal laser anneal reduced overlay to 0.95nm.",
        URL_C3_REGRESSION,
        hashes["c3_regression"],
    )

    set_sender(ADDR_AUDITOR)
    assert c.adjudicate_cure_tender("cov_c3") == "ROUND2:cov_c3:CURE_DEFICIENT:REGRESSION_INTRODUCED"

    cov = json.loads(c.get_covenant("cov_c3"))
    assert cov["status"] == "DEFAULTED_CLOSED"
    assert c.get_pending_payout(ADDR_BUYER) == 1100
    assert c.get_pending_payout(ADDR_SUPPLIER) == 0

    set_sender(ADDR_BUYER)
    assert c.withdraw_payout() == 1100


# =============================================================================
# 4. Transient UNVERIFIABLE Retriability & Safe No-Fault Unwind
# =============================================================================
def test_retriable_unverifiable_in_both_rounds_and_safe_unwind():
    hashes = setup_standard_fixtures()
    setup_standard_llm()
    c = CureLatch()
    set_time(1794900000)

    # Round 1: Transient HTTP 503 fails soft as UNVERIFIABLE, recovers on Attempt 2
    _open_standard_covenant(c, "cov_retry")
    set_sender(ADDR_BUYER)
    set_value(100)
    c.file_defect_notice("cov_retry", 100, "Overlay shift.", URL_A1_DEFECT, hashes["a1_defect"])
    set_value(0)

    saved_resp = mock_web_responses[URL_A1_DEFECT]
    mock_web_responses[URL_A1_DEFECT] = MockWebResponse(status=503, body=b"Upstream Timeout")
    assert c.adjudicate_defect_notice("cov_retry") == "ROUND1:cov_retry:UNVERIFIABLE:FETCH_OR_PARSE_FAILURE"

    cov1 = json.loads(c.get_covenant("cov_retry"))
    assert cov1["status"] == "NOTICE_FILED"  # Retriable, not finalized!
    assert cov1["round1_attempts"] == 1
    assert c.get_pending_payout(ADDR_SUPPLIER) == 0
    assert c.get_pending_payout(ADDR_BUYER) == 0

    # Recovery on attempt 2 succeeds cleanly
    mock_web_responses[URL_A1_DEFECT] = saved_resp
    assert c.adjudicate_defect_notice("cov_retry") == "ROUND1:cov_retry:BREACH_LATCHED:VERIFIED_OVERLAY_DEFECT"
    cov2 = json.loads(c.get_covenant("cov_retry"))
    assert cov2["status"] == "BREACH_LATCHED"
    assert cov2["round1_attempts"] == 2

    # Round 2: Persistent HTTP 503 for 5 attempts caps out and unlocks safe unwind
    set_sender(ADDR_SUPPLIER)
    c.submit_cure_tender("cov_retry", "Recalibrated stage.", URL_A1_CURE, hashes["a1_cure"])
    mock_web_responses[URL_A1_CURE] = MockWebResponse(status=503, body=b"Offline")

    # Cannot unwind prematurely while < 5 attempts and before unwind_deadline
    with pytest.raises(UserError, match="UNWIND_CONDITIONS_NOT_MET"):
        c.unwind_unverifiable_covenant("cov_retry")

    for i in range(1, MAX_EVAL_ATTEMPTS + 1):
        res = c.adjudicate_cure_tender("cov_retry")
        assert res == "ROUND2:cov_retry:UNVERIFIABLE:FETCH_OR_PARSE_FAILURE"
        assert json.loads(c.get_covenant("cov_retry"))["round2_attempts"] == i

    # 6th attempt blocked by retry cap
    with pytest.raises(UserError, match="MAX_EVAL_ATTEMPTS_REACHED"):
        c.adjudicate_cure_tender("cov_retry")

    # Safe permissionless no-fault unwind returns bond -> Supplier, stake -> Buyer
    set_sender(ADDR_AUDITOR)
    assert c.unwind_unverifiable_covenant("cov_retry") == "UNWOUND_REFUNDED:cov_retry"
    assert c.get_pending_payout(ADDR_SUPPLIER) == 1000
    assert c.get_pending_payout(ADDR_BUYER) == 100

    set_sender(ADDR_SUPPLIER)
    assert c.withdraw_payout() == 1000
    set_sender(ADDR_BUYER)
    assert c.withdraw_payout() == 100


# =============================================================================
# 5. Verdict/Reason Compatibility Tables & Adversarial Leader Rejection
# =============================================================================
def test_verdict_reason_compatibility_tables_and_adversarial_leader_rejection():
    hashes = setup_standard_fixtures()
    setup_standard_llm()

    # Cross-pairing verdict and reason fails closed in normalization
    bad_r1 = normalize_round1_result("cov", "d" * 64, "BREACH_LATCHED", "LOT_WITHIN_TOLERANCE")
    assert bad_r1["verdict"] == "UNVERIFIABLE"
    assert bad_r1["reason_code"] == "AMBIGUOUS_METROLOGY"
    assert bad_r1["defect_domain"] == "NONE"

    bad_r2 = normalize_round2_result("cov", "LITHOGRAPHY_OVERLAY", "d" * 64, "CURE_VERIFIED", "REGRESSION_INTRODUCED")
    assert bad_r2["verdict"] == "UNVERIFIABLE"
    assert bad_r2["reason_code"] == "AMBIGUOUS_METROLOGY"

    # Direct validator checks reject domain mismatch, incompatible reason, extra keys
    val_r1 = {
        "covenant_id": "cov_adv",
        "defect_domain": "LITHOGRAPHY_OVERLAY",
        "evidence_digest": hashes["a1_defect"],
        "reason_code": "VERIFIED_OVERLAY_DEFECT",
        "verdict": "BREACH_LATCHED",
    }
    assert validate_leader_round1(val_r1, val_r1) is True

    wrong_domain = dict(val_r1, defect_domain="INTERCONNECT_SHORT")
    assert validate_leader_round1(wrong_domain, val_r1) is False

    extra_key = dict(val_r1, extra="x")
    assert validate_leader_round1(extra_key, val_r1) is False

    val_r2 = {
        "covenant_id": "cov_adv",
        "evidence_digest": hashes["a1_cure"],
        "latched_defect_domain": "LITHOGRAPHY_OVERLAY",
        "reason_code": "CAUSAL_CURE_CONFIRMED",
        "verdict": "CURE_VERIFIED",
    }
    assert validate_leader_round2(val_r2, val_r2) is True
    assert validate_leader_round2(dict(val_r2, reason_code="WRONG_DOMAIN_REMEDIATION"), val_r2) is False

    # On-chain Byzantine leader tampering test
    c = CureLatch()
    set_time(1794900000)
    _open_standard_covenant(c, "cov_adv")
    set_sender(ADDR_BUYER)
    set_value(100)
    c.file_defect_notice("cov_adv", 100, "Overlay shift.", URL_A1_DEFECT, hashes["a1_defect"])
    set_value(0)

    def spoof_reason(leader_res: dict) -> dict:
        tampered = dict(leader_res)
        tampered["reason_code"] = "VERIFIED_INTERCONNECT_SHORT"
        tampered["defect_domain"] = "INTERCONNECT_SHORT"
        return tampered

    gl_mock.adversarial_leader_fn = spoof_reason
    with pytest.raises(UserError, match="CONSENSUS_VALIDATION_FAILED"):
        c.adjudicate_defect_notice("cov_adv")


# =============================================================================
# 6. Ceiling Stake Rounding & Payable Value / Input Bounds Guards
# =============================================================================
def test_ceiling_stake_rounding_and_input_validation_guards():
    # Ceiling math: exact 10% rounded UP, min 10 wei floor
    assert compute_required_stake(100) == 10
    assert compute_required_stake(101) == 11   # (101*10 + 99)//100 = 11 (ceil, not floor 10!)
    assert compute_required_stake(109) == 11
    assert compute_required_stake(110) == 11
    assert compute_cure_indemnity(1000, 1500) == 150

    c = CureLatch()
    set_time(1794900000)
    set_sender(ADDR_SUPPLIER)

    # Wrong attached value reverts atomically (contract_balance remains 0!)
    set_value(50)
    with pytest.raises(UserError, match="INVALID_ATTACHED_VALUE"):
        c.open_covenant("cov_1", ADDR_BUYER, 100, 1500, 600, 600, TECH_SPEC, REPO_PREFIX)
    assert int(c.balance) == 0

    # Bool disguised as int / self-dealing buyer / zero address / bad bps revert cleanly
    set_value(101)
    with pytest.raises(UserError, match="INVALID_BOND_AMOUNT"):
        c.open_covenant("cov_b", ADDR_BUYER, True, 1500, 600, 600, TECH_SPEC, REPO_PREFIX)
    with pytest.raises(UserError, match="BUYER_CANNOT_BE_SUPPLIER"):
        c.open_covenant("cov_s", ADDR_SUPPLIER, 101, 1500, 600, 600, TECH_SPEC, REPO_PREFIX)
    with pytest.raises(UserError, match="INVALID_BUYER_ADDRESS"):
        c.open_covenant("cov_z", ZERO_ADDRESS, 101, 1500, 600, 600, TECH_SPEC, REPO_PREFIX)
    assert int(c.balance) == 0

    # Open with 101 bond -> required_stake must be ceiling 11, NOT 10
    assert c.open_covenant("cov_ceil", ADDR_BUYER, 101, 1500, 600, 600, TECH_SPEC, REPO_PREFIX) == "COVENANT_OPENED:cov_ceil:REQ_STAKE_11"
    set_sender(ADDR_BUYER)
    set_value(10)
    with pytest.raises(UserError, match="INSUFFICIENT_INSPECTION_STAKE"):
        c.file_defect_notice("cov_ceil", 10, "Overlay shift.", URL_A1_DEFECT, "a" * 64)
    assert int(c.balance) == 101  # No swallowed stake from failed tx


# =============================================================================
# 7. Unauthorized Callers & Conclusive Immutability Guards
# =============================================================================
def test_unauthorized_callers_and_conclusive_immutability_guards():
    hashes = setup_standard_fixtures()
    setup_standard_llm()
    c = CureLatch()
    set_time(1794900000)
    _open_standard_covenant(c, "cov_auth")

    # Non-buyer cannot file defect notice
    set_sender(ADDR_ATTACKER)
    set_value(100)
    with pytest.raises(UserError, match="UNAUTHORIZED_CALLER"):
        c.file_defect_notice("cov_auth", 100, "Spoof notice.", URL_A1_DEFECT, hashes["a1_defect"])
    set_value(0)

    # Buyer files properly
    set_sender(ADDR_BUYER)
    set_value(100)
    c.file_defect_notice("cov_auth", 100, "Overlay shift.", URL_A1_DEFECT, hashes["a1_defect"])
    set_value(0)

    # Cannot tender cure before Round 1 concludes
    set_sender(ADDR_SUPPLIER)
    with pytest.raises(UserError, match="INVALID_COVENANT_STATE"):
        c.submit_cure_tender("cov_auth", "Premature cure.", URL_A1_CURE, hashes["a1_cure"])

    # Round 1 concludes BREACH_LATCHED -> cannot re-run Round 1 (conclusive immutability)
    c.adjudicate_defect_notice("cov_auth")
    with pytest.raises(UserError, match="ROUND1_ALREADY_CONCLUDED"):
        c.adjudicate_defect_notice("cov_auth")

    # Non-supplier cannot submit cure tender
    set_sender(ADDR_ATTACKER)
    with pytest.raises(UserError, match="UNAUTHORIZED_CALLER"):
        c.submit_cure_tender("cov_auth", "Attacker cure.", URL_A1_CURE, hashes["a1_cure"])

    # Attacker cannot withdraw non-existent payout
    with pytest.raises(UserError, match="NO_PENDING_PAYOUT"):
        c.withdraw_payout()

    # Round 2 concludes CURE_VERIFIED -> cannot re-run Round 2
    set_sender(ADDR_SUPPLIER)
    c.submit_cure_tender("cov_auth", "Recalibrated stage.", URL_A1_CURE, hashes["a1_cure"])
    c.adjudicate_cure_tender("cov_auth")
    with pytest.raises(UserError, match="ROUND2_ALREADY_CONCLUDED"):
        c.adjudicate_cure_tender("cov_auth")


# =============================================================================
# 8. Repository Prefix Binding & Round 2 Anti-Replay Guards
# =============================================================================
def test_repo_prefix_binding_and_round2_anti_replay_guards():
    hashes = setup_standard_fixtures()
    setup_standard_llm()
    c = CureLatch()
    set_time(1794900000)
    _open_standard_covenant(c, "cov_bind")

    set_sender(ADDR_BUYER)
    set_value(100)

    # Unpinned /main/ URL rejected
    with pytest.raises(UserError, match="INVALID_EVIDENCE_URL"):
        c.file_defect_notice(
            "cov_bind",
            100,
            "Mutable URL",
            f"{REPO_PREFIX}main/evidence/lot_a1_defect_overlay.json",
            hashes["a1_defect"],
        )

    # Foreign repo URL rejected
    with pytest.raises(UserError, match="REPO_PREFIX_MISMATCH"):
        c.file_defect_notice(
            "cov_bind",
            100,
            "Off-repo URL",
            f"{FOREIGN_PREFIX}{COMMIT_A}/evidence/lot_a1_defect_overlay.json",
            hashes["a1_defect"],
        )

    assert is_valid_evidence_url(f"{URL_A1_DEFECT}?raw=1", REPO_PREFIX) is False
    assert is_valid_evidence_url(f"{REPO_PREFIX}{COMMIT_A}/../secret.json", REPO_PREFIX) is False

    # Valid notice & Round 1 latch
    c.file_defect_notice("cov_bind", 100, "Overlay shift.", URL_A1_DEFECT, hashes["a1_defect"])
    set_value(0)
    c.adjudicate_defect_notice("cov_bind")

    # Round 2 rejects foreign repo URL and replaying Round 1's evidence URL or hash
    set_sender(ADDR_SUPPLIER)
    with pytest.raises(UserError, match="REPO_PREFIX_MISMATCH"):
        c.submit_cure_tender(
            "cov_bind",
            "Off-repo cure",
            f"{FOREIGN_PREFIX}{COMMIT_B}/evidence/lot_a1_cure_recalibrated.json",
            hashes["a1_cure"],
        )

    with pytest.raises(UserError, match="REPLAYED_ROUND1_EVIDENCE"):
        c.submit_cure_tender("cov_bind", "Replayed URL", URL_A1_DEFECT, hashes["a1_cure"])

    with pytest.raises(UserError, match="REPLAYED_ROUND1_EVIDENCE"):
        c.submit_cure_tender("cov_bind", "Replayed hash", URL_A1_CURE, hashes["a1_defect"])


# =============================================================================
# 9. Fail-Closed Evidence Failures & Missing GenVM Clock
# =============================================================================
def test_fail_closed_evidence_errors_and_no_block_time():
    hashes = setup_standard_fixtures()
    c = CureLatch()

    # Fail closed on missing GenVM timestamp
    set_time(None)
    set_sender(ADDR_SUPPLIER)
    set_value(1000)
    with pytest.raises(UserError, match="NO_BLOCK_TIME"):
        c.open_covenant("cov_notime", ADDR_BUYER, 1000, 1500, 1800, 3600, TECH_SPEC, REPO_PREFIX)
    assert int(c.balance) == 0

    set_time(1794900000)
    bad_cases = [
        ("cov_404", f"{REPO_PREFIX}{COMMIT_A}/missing.json", MockWebResponse(status=404, body=b"Not Found"), "0" * 64, "FETCH_OR_PARSE_FAILURE"),
        ("cov_empty", f"{REPO_PREFIX}{COMMIT_A}/empty.json", MockWebResponse(status=200, body=b""), _sha256_hex(b""), "FETCH_OR_PARSE_FAILURE"),
        ("cov_big", f"{REPO_PREFIX}{COMMIT_A}/big.json", MockWebResponse(status=200, body=b"X" * (MAX_EVIDENCE_BYTES + 1)), _sha256_hex(b"X" * (MAX_EVIDENCE_BYTES + 1)), "FETCH_OR_PARSE_FAILURE"),
        ("cov_utf8", f"{REPO_PREFIX}{COMMIT_A}/bad.bin", MockWebResponse(status=200, body=b"\xff\xfe\x00\xaa"), _sha256_hex(b"\xff\xfe\x00\xaa"), "FETCH_OR_PARSE_FAILURE"),
        ("cov_hash", URL_A1_DEFECT, MockWebResponse(status=200, body=_read_fixture("lot_a1_defect_overlay.json")), "f" * 64, "HASH_MISMATCH"),
    ]

    for cov_id, url, resp, h, expected_reason in bad_cases:
        mock_web_responses[url] = resp
        _open_standard_covenant(c, cov_id)
        set_sender(ADDR_BUYER)
        set_value(100)
        c.file_defect_notice(cov_id, 100, "Edge test.", url, h)
        set_value(0)
        res = c.adjudicate_defect_notice(cov_id)
        assert res == f"ROUND1:{cov_id}:UNVERIFIABLE:{expected_reason}"
        assert json.loads(c.get_covenant(cov_id))["status"] == "NOTICE_FILED"


# =============================================================================
# 10. Post-Deadline Expiries & Multi-Covenant Conservation Invariant
# =============================================================================
def test_post_deadline_expiries_and_accounting_conservation_invariant():
    hashes = setup_standard_fixtures()
    setup_standard_llm()
    c = CureLatch()

    def assert_conservation():
        acct = json.loads(c.get_accounting_state())
        assert (
            acct["total_locked_bonds"]
            + acct["total_locked_stakes"]
            + acct["total_pending_withdrawals"]
            + acct["total_withdrawn"]
            == acct["total_deposited"]
        )
        assert (
            acct["total_locked_bonds"]
            + acct["total_locked_stakes"]
            + acct["total_pending_withdrawals"]
            == acct["contract_balance"]
        )

    set_time(1794900000)
    assert_conservation()

    # Covenant 1: Never noticed -> expires unnoticed after notice_deadline
    _open_standard_covenant(c, "cov_exp1")
    assert_conservation()
    with pytest.raises(UserError, match="NOTICE_WINDOW_STILL_ACTIVE"):
        c.expire_unnoticed_covenant("cov_exp1")

    # Covenant 2: Defect noticed & latched, Supplier fails to cure before cure_deadline
    _open_standard_covenant(c, "cov_exp2")
    set_sender(ADDR_BUYER)
    set_value(100)
    c.file_defect_notice("cov_exp2", 100, "Overlay defect.", URL_A1_DEFECT, hashes["a1_defect"])
    set_value(0)
    c.adjudicate_defect_notice("cov_exp2")
    assert_conservation()

    with pytest.raises(UserError, match="CURE_WINDOW_STILL_ACTIVE"):
        c.expire_uncured_breach("cov_exp2")

    # Advance past notice_deadline (1800) & cure_deadline (3600)
    set_time(1794900000 + 3600)
    set_sender(ADDR_ATTACKER)  # Permissionless expiry triggers
    assert c.expire_unnoticed_covenant("cov_exp1") == "EXPIRED_UNNOTICED:cov_exp1"
    assert c.expire_uncured_breach("cov_exp2") == "DEFAULTED_UNCURED:cov_exp2"
    assert_conservation()

    # Supplier reclaims cov_exp1 bond (1000); Buyer takes cov_exp2 bond+stake (1100)
    set_sender(ADDR_SUPPLIER)
    assert c.withdraw_payout() == 1000
    assert_conservation()

    set_sender(ADDR_BUYER)
    assert c.withdraw_payout() == 1100
    assert_conservation()

    acct = json.loads(c.get_accounting_state())
    assert acct == {
        "contract_balance": 0,
        "total_deposited": 2100,
        "total_locked_bonds": 0,
        "total_locked_stakes": 0,
        "total_pending_withdrawals": 0,
        "total_withdrawn": 2100,
    }
