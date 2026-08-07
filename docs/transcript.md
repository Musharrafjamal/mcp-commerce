# Captured wire transcript

Against `https://ops-copilot-musharraf008s-projects.vercel.app/api/mcp` on 2026-08-07.

> **What this is.** Every request and response below is genuine and unedited, captured over raw JSON-RPC against the deployed server by `scripts/capture-transcript.ts`. Responses are trimmed to the relevant fields — nothing is rewritten.
>
> **What this is not.** The *script* chose the tool sequence, not a language model. This proves what the server does; it does not prove a live model picks the right tools in the right order. That gap is named in the README, and an agentic eval is the fix.

---

**Server:** `ops-copilot` v1.0.0  
**Tools:** `ops_list_delayed_shipments`, `ops_investigate_delivery_exception`, `ops_verify_carrier_exception`, `ops_preview_refund`, `ops_issue_refund`

---

## 1. What needs attention

The triage queue. 7 of 28 seeded orders are open exceptions — the other 21 are healthy and correctly absent.

**Request**
```json
{
  "method": "tools/call",
  "params": {
    "name": "ops_list_delayed_shipments",
    "arguments": {
      "min_severity": "all",
      "limit": 25
    }
  }
}
```

**Response** — `structuredContent`, trimmed to the fields that matter
```json
{
  "total_open": 7,
  "showing": 7
}
```


First row:
```json
{
  "order_id": "ORD-1003",
  "exception_code": "DISPUTED_DELIVERY",
  "severity": "critical",
  "age_days": 9,
  "one_line_why": "Carrier recorded a delivery at the shipping address, but the customer reports non-receipt.",
  "next_step": "ops_investigate_delivery_exception(order_ref: \"ORD-1003\")"
}
```

## 2. Investigate ORD-1001

One call joins the order, the payment ledger and the carrier scan history, and returns ranked causes with the evidence for each. Note `carrier_verification: null` — no refund can be authorised yet.

**Request**
```json
{
  "method": "tools/call",
  "params": {
    "name": "ops_investigate_delivery_exception",
    "arguments": {
      "order_ref": "ORD-1001"
    }
  }
}
```

**Response** — `structuredContent`, trimmed to the fields that matter
```json
{
  "order_id": "ORD-1001",
  "captured": {
    "minor": 8708,
    "currency": "USD",
    "display": "$87.08"
  },
  "refunded": {
    "minor": 0,
    "currency": "USD",
    "display": "$0.00"
  },
  "refundable_now": {
    "minor": 8708,
    "currency": "USD",
    "display": "$87.08"
  },
  "confidence_band": "high",
  "requires_human_judgment": false,
  "eligible_remedies": [
    "refund"
  ],
  "next": "ops_verify_carrier_exception(order_ref: \"ORD-1001\")"
}
```


## 3. Try to refund before asking the carrier

Refused. Rule `P3` requires a carrier verification less than 24 hours old. Note this comes back as a normal result, **not** an error — an error would invite the model to reshape the request and retry.

**Request**
```json
{
  "method": "tools/call",
  "params": {
    "name": "ops_preview_refund",
    "arguments": {
      "order_ref": "ORD-1001",
      "target": {
        "mode": "full_order"
      }
    }
  }
}
```

**Response** — `structuredContent`, trimmed to the fields that matter
```json
{
  "policy": {
    "decision": "deny",
    "rules": [
      {
        "id": "P1_REFUND_CEILING",
        "verdict": "allow",
        "detail": "$87.08 is within the $150.00 ceiling."
      },
      {
        "id": "P2_REFUND_LE_CAPTURED",
        "verdict": "allow",
        "detail": "$87.08 total refunds stays within $87.08 captured."
      },
      {
        "id": "P3_CARRIER_VERIFIED",
        "verdict": "deny",
        "detail": "No carrier verification on file. Call ops_verify_carrier_exception before proposing a refund."
      },
      {
        "id": "P4_LOW_CONFIDENCE",
        "verdict": "allow",
        "detail": "Diagnostic confidence is high."
      },
      {
        "id": "P5_DISPUTED_DELIVERY",
        "verdict": "allow",
        "detail": "No delivery dispute on this order."
      },
      {
        "id": "P6_DEAD_INSTRUMENT",
        "verdict": "allow",
        "detail": "The original payment instrument is usable."
      },
      {
        "id": "P7_NO_DUPLICATE_REMEDY",
        "verdict": "allow",
        "detail": "No identical refund in the dedupe window."
      },
      {
        "id": "P8_CIRCUIT_BREAKER",
        "verdict": "allow",
        "detail": "Within blast-radius limits."
      },
      {
        "id": "P9_ORDER_STATE",
        "verdict": "allow",
        "detail": "Order status \"open\" permits a refund."
      }
    ],
    "guidance": "No carrier verification on file. Call ops_verify_carrier_exception before proposing a refund. Do not retry with a smaller amount or a different line selection. This is a hard rule, not a threshold — a reshaped request will be refused for the same reason. Report the finding and stop.",
    "do_not_retry": true
  },
  "next": "No carrier verification on file. Call ops_verify_carrier_exception before proposing a refund. Do not retry with a smaller amount or a different line selection. This is a hard rule, not a threshold — a reshaped request will be refused for the same reason. Report the finding and stop."
}
```


## 4. Ask the carrier

The step that separates a lost parcel from a merely late one. Our own records cannot.

**Request**
```json
{
  "method": "tools/call",
  "params": {
    "name": "ops_verify_carrier_exception",
    "arguments": {
      "order_ref": "ORD-1001"
    }
  }
}
```

**Response** — `structuredContent`, trimmed to the fields that matter
```json
{
  "order_id": "ORD-1001",
  "tracking_number": "PP1001001",
  "status": "LOST_IN_TRANSIT",
  "refund_precondition_met": true,
  "carrier_note": "Trace closed. Parcel declared lost in transit.",
  "next": "ops_preview_refund(order_ref: \"ORD-1001\")"
}
```


## 5. Preview the refund

The same order, now allowed. The amount is computed by the server from the payment ledger — there is no input field anywhere for a model to supply one. All nine policy rules report a verdict.

**Request**
```json
{
  "method": "tools/call",
  "params": {
    "name": "ops_preview_refund",
    "arguments": {
      "order_ref": "ORD-1001",
      "target": {
        "mode": "full_order"
      }
    }
  }
}
```

**Response** — `structuredContent`, trimmed to the fields that matter
```json
{
  "plan_id": "PLAN-492ED05DF3AC42719E73",
  "expires_at": "2026-08-07T06:49:46.445Z",
  "execute_with": "ops_issue_refund(plan_id: \"PLAN-492ED05DF3AC42719E73\")",
  "computed": {
    "amount": {
      "minor": 8708,
      "currency": "USD",
      "display": "$87.08"
    },
    "target_payment_id": "PAY-1001",
    "target_transaction_id": "TXN-1001-C",
    "line_ids": [
      "ORD-1001-L1"
    ],
    "captured_total": {
      "minor": 8708,
      "currency": "USD",
      "display": "$87.08"
    },
    "already_refunded": {
      "minor": 0,
      "currency": "USD",
      "display": "$0.00"
    }
  },
  "effects": [
    "Refund $87.08 against payment PAY-1001 (capture TXN-1001-C).",
    "Total refunds on #1001 would go from $0.00 to $87.08 of $87.08 captured.",
    "Lines affected: ORD-1001-L1.",
    "Shipment PP1001001 is not altered; this is a monetary remedy only."
  ]
}
```


Policy verdict:
```json
{
  "decision": "allow",
  "do_not_retry": false,
  "guidance": "Every condition passed. Execute the plan with ops_issue_refund."
}
```

## 6. Execute

The only input is the plan id.

**Request**
```json
{
  "method": "tools/call",
  "params": {
    "name": "ops_issue_refund",
    "arguments": {
      "plan_id": "PLAN-492ED05DF3AC42719E73"
    }
  }
}
```

**Response** — `structuredContent`, trimmed to the fields that matter
```json
{
  "action_id": "PLAN-492ED05DF3AC42719E73",
  "status": "executed",
  "replayed": false,
  "effect_summary": "Refunded $87.08 to Ava Okafor for #1001.",
  "audit_url": "/audit#PLAN-492ED05DF3AC42719E73",
  "next": "Confirm with ops_investigate_delivery_exception(order_ref: \"ORD-1001\") — the refund should now appear in the timeline."
}
```


## 7. Issue the identical plan again

`replayed: true`, and the cached result is returned byte-for-byte. One refund transaction exists, not two.

**Request**
```json
{
  "method": "tools/call",
  "params": {
    "name": "ops_issue_refund",
    "arguments": {
      "plan_id": "PLAN-492ED05DF3AC42719E73"
    }
  }
}
```

**Response** — `structuredContent`, trimmed to the fields that matter
```json
{
  "action_id": "PLAN-492ED05DF3AC42719E73",
  "status": "executed",
  "replayed": true,
  "effect_summary": "Refunded $87.08 to Ava Okafor for #1001."
}
```


## 8. ORD-1006 — indistinguishable from ORD-1001 in our data

Same scan gap, same breached promise date. Ask the carrier and the answer is different.

**Request**
```json
{
  "method": "tools/call",
  "params": {
    "name": "ops_verify_carrier_exception",
    "arguments": {
      "order_ref": "ORD-1006"
    }
  }
}
```

**Response** — `structuredContent`, trimmed to the fields that matter
```json
{
  "status": "IN_TRANSIT",
  "revised_eta": "2026-08-09T06:34:50.342Z",
  "refund_precondition_met": false,
  "carrier_note": "Parcel located at partner facility. Weather delay. Revised ETA issued.",
  "next": "A refund is premature. Tell the operator the parcel is moving with a revised ETA of 2026-08-09, and stop."
}
```


## 9. So the refund is refused as premature

This is the client’s "verified carrier exception" doing real work rather than being a label.

**Request**
```json
{
  "method": "tools/call",
  "params": {
    "name": "ops_preview_refund",
    "arguments": {
      "order_ref": "ORD-1006",
      "target": {
        "mode": "full_order"
      }
    }
  }
}
```

**Response** — `structuredContent`, trimmed to the fields that matter
```json
{
  "policy": {
    "decision": "deny",
    "rules": [
      {
        "id": "P1_REFUND_CEILING",
        "verdict": "allow",
        "detail": "$96.80 is within the $150.00 ceiling."
      },
      {
        "id": "P2_REFUND_LE_CAPTURED",
        "verdict": "allow",
        "detail": "$96.80 total refunds stays within $96.80 captured."
      },
      {
        "id": "P3_CARRIER_VERIFIED",
        "verdict": "deny",
        "detail": "The carrier reports the parcel is still in transit, revised ETA 2026-08-09. A refund is premature."
      },
      {
        "id": "P4_LOW_CONFIDENCE",
        "verdict": "allow",
        "detail": "Diagnostic confidence is high."
      },
      {
        "id": "P5_DISPUTED_DELIVERY",
        "verdict": "allow",
        "detail": "No delivery dispute on this order."
      },
      {
        "id": "P6_DEAD_INSTRUMENT",
        "verdict": "allow",
        "detail": "The original payment instrument is usable."
      },
      {
        "id": "P7_NO_DUPLICATE_REMEDY",
        "verdict": "allow",
        "detail": "No identical refund in the dedupe window."
      },
      {
        "id": "P8_CIRCUIT_BREAKER",
        "verdict": "deny",
        "detail": "demo-operator has executed 3 refunds in the last 10 minutes. Halting and escalating rather than continuing."
      },
      {
        "id": "P9_ORDER_STATE",
        "verdict": "allow",
        "detail": "Order status \"open\" permits a refund."
      }
    ],
    "guidance": "The carrier reports the parcel is still in transit, revised ETA 2026-08-09. A refund is premature. demo-operator has executed 3 refunds in the last 10 minutes. Halting and escalating rather than continuing. Do not retry with a smaller amount or a different line selection. This is a hard rule, not a threshold — a reshaped request will be refused for the same reason. Report the finding and stop.",
    "do_not_retry": true
  }
}
```


## 10. ORD-1003 — the engine declines to conclude

A delivered scan 28 m from the door, and a customer reporting non-receipt. Competing explanations that cannot be separated on the evidence.

**Request**
```json
{
  "method": "tools/call",
  "params": {
    "name": "ops_investigate_delivery_exception",
    "arguments": {
      "order_ref": "ORD-1003"
    }
  }
}
```

**Response** — `structuredContent`, trimmed to the fields that matter
```json
{
  "confidence_band": "low",
  "requires_human_judgment": true,
  "eligible_remedies": [
    "none"
  ],
  "signals": [
    "This customer has 1 earlier non-receipt claim(s) in the last 180 days: ORD-0977."
  ]
}
```


Root causes — each carrying evidence **against** it as well as for:
```json
[
  {
    "code": "DELIVERED_THEN_LOST",
    "confidence": 0.44,
    "supporting": 2,
    "contradicting": 1
  },
  {
    "code": "CARRIER_FALSE_DELIVERY_SCAN",
    "confidence": 0.44,
    "supporting": 1,
    "contradicting": 1
  }
]
```

## 11. ORD-1004 — the ledger outranks the order record

The order status still reads `open`, but the payment ledger shows it was already refunded in full. This one fails before policy is even consulted.

**Request**
```json
{
  "method": "tools/call",
  "params": {
    "name": "ops_preview_refund",
    "arguments": {
      "order_ref": "ORD-1004",
      "target": {
        "mode": "full_order"
      }
    }
  }
}
```

**Response** — `isError: true`, and the text the agent receives:

```text
**NOTHING_REFUNDABLE** — Order ORD-1004 has nothing left to refund — $63.32 of $63.32 captured has already been refunded, whatever the order status says.

**Do this next:** ops_investigate_delivery_exception(order_ref: "ORD-1004") to see what has already been refunded.
```

## 12. An invented plan id

Plan ids are minted by the server and regex-pinned in the schema. A fabricated one cannot execute.

**Request**
```json
{
  "method": "tools/call",
  "params": {
    "name": "ops_issue_refund",
    "arguments": {
      "plan_id": "PLAN-IMADETHISUPMYSELF1"
    }
  }
}
```

**Response** — `isError: true`, and the text the agent receives:

```text
Input validation error: Invalid arguments for tool ops_issue_refund: plan_id: plan_id must come from ops_preview_refund; it cannot be constructed by hand.
```

---

Regenerate with `bun run capture:transcript`. Reset the dataset afterwards with `bun run seed` or the console button, since this transcript executes a real refund.
