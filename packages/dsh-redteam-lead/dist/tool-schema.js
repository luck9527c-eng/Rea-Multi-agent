/**
 * 包内 tool schema 副本 —— 数据源是 `docs/specs/rt-tools.schema.json`（唯一权威），本文件只是
 * 一份**逐字复制**的 `$defs`，不做任何改写、不手写变体。
 *
 * 为什么要有副本：本地 `link:` 安装的 bundle 按自身真实路径解析模块，读不到仓库里的
 * `docs/`；工具注册又必须在模块加载时就有完整的 raw JSON Schema。
 *
 * 漂移测试在 `test/bundle.test.mjs`：把本文件的每个 `$defs` 与规格逐项深比较，不一致即失败。
 * 所以**不要在这里手改**：要改先改规格（docs/specs 由 Lead 维护），再重新生成本文件。
 *
 * @module @local/dsh-redteam-lead/tool-schema
 */
import { recordOf } from './guards.js';
/** 规格文件的完整内容（含 `$schema` / `$id` / `$defs`），逐字复制。 */
const SPEC = {
    "$schema": "https://json-schema.org/draft/2020-12/schema",
    "$id": "urn:rea-multi-agent:tools:v1",
    "title": "Rea-Multi-agent tool contract v1",
    "$ref": "#/$defs/request",
    "$defs": {
        "text": {
            "type": "string",
            "minLength": 1,
            "pattern": "\\S"
        },
        "id": {
            "type": "string",
            "pattern": "^[a-z0-9][a-z0-9_-]{0,95}$"
        },
        "sha256": {
            "type": "string",
            "pattern": "^[0-9a-f]{64}$"
        },
        "path": {
            "type": "string",
            "minLength": 1,
            "description": "Project-relative forward-slash path; semantic containment and reparse-point checks are mandatory."
        },
        "root": {
            "type": "string",
            "minLength": 1,
            "description": "Explicitly selected absolute local analysis root; canonicalized and binding-checked."
        },
        "routeId": {
            "type": "string",
            "pattern": "^R-[A-Za-z0-9_-]+$"
        },
        "runId": {
            "type": "string",
            "pattern": "^RUN-[A-Za-z0-9_-]+$"
        },
        "dispatchId": {
            "type": "string",
            "pattern": "^D-[a-z0-9][a-z0-9_-]{0,63}$"
        },
        "attemptId": {
            "type": "string",
            "pattern": "^A-[0-9]{6}$"
        },
        "strings": {
            "type": "array",
            "items": {
                "$ref": "#/$defs/text"
            },
            "uniqueItems": true
        },
        "kinds": {
            "type": "array",
            "items": {
                "enum": [
                    "binary",
                    "game",
                    "webapp"
                ]
            },
            "uniqueItems": true
        },
        "date": {
            "type": "string",
            "format": "date-time"
        },
        "routeStatus": {
            "enum": [
                "planned",
                "active",
                "blocked",
                "paused",
                "validated",
                "falsified",
                "superseded"
            ]
        },
        "outcome": {
            "enum": [
                "finding",
                "no_finding",
                "refuted",
                "blocked",
                "budget_exhausted",
                "failed",
                "cancelled"
            ]
        },
        "errorCode": {
            "enum": [
                "INVALID_ARGUMENT",
                "ROLE_REQUIRED",
                "PATH_INVALID",
                "TEAM_SERVICE_UNAVAILABLE",
                "PROJECT_NOT_CONFIGURED",
                "SKILL_INCOMPATIBLE",
                "PROJECT_SESSION_MISMATCH",
                "PROJECT_BUSY",
                "UNKNOWN_CAPABILITY",
                "CAPABILITY_MISSING",
                "CAPABILITY_NOT_READY",
                "CAPACITY_UNKNOWN",
                "CAPACITY_EXHAUSTED",
                "POST_DISABLED",
                "MEMBER_BUSY",
                "DEPENDENCY_BLOCKED",
                "RESOURCE_BINDING_MISSING",
                "RESOURCE_BUSY",
                "DELIVERY_FAILED",
                "START_ACK_TIMEOUT",
                "RECOVERY_REQUIRED",
                "OPERATION_CONFLICT",
                "REVISION_CONFLICT",
                "STALE_ATTEMPT",
                "SUBMISSION_INVALID",
                "BASELINE_MISMATCH",
                "CHECK_FAILED",
                "UNREVIEWED_COMPLETION"
            ]
        },
        "anchorKind": {
            "enum": [
                "binary_location",
                "source_location",
                "web_capture",
                "runtime_event",
                "evidence_export",
                "artifact_locator"
            ]
        },
        "resource": {
            "type": "object",
            "additionalProperties": false,
            "required": [
                "resource_key",
                "mode"
            ],
            "properties": {
                "resource_key": {
                    "$ref": "#/$defs/text"
                },
                "mode": {
                    "enum": [
                        "shared_read",
                        "exclusive"
                    ]
                }
            }
        },
        "anchorRef": {
            "type": "object",
            "additionalProperties": false,
            "required": [
                "kind",
                "run_id",
                "path",
                "locator"
            ],
            "properties": {
                "kind": {
                    "$ref": "#/$defs/anchorKind"
                },
                "run_id": {
                    "$ref": "#/$defs/runId"
                },
                "path": {
                    "$ref": "#/$defs/path"
                },
                "locator": {
                    "$ref": "#/$defs/text"
                }
            }
        },
        "rosterInput": {
            "type": "object",
            "additionalProperties": false,
            "required": [
                "project_root"
            ],
            "properties": {
                "project_root": {
                    "$ref": "#/$defs/root"
                },
                "action": {
                    "enum": [
                        "inspect",
                        "bind",
                        "takeover"
                    ],
                    "default": "inspect"
                },
                "target_kinds": {
                    "$ref": "#/$defs/kinds",
                    "default": []
                },
                "max_posts": {
                    "type": "integer",
                    "minimum": 1,
                    "default": 6
                },
                "operation_id": {
                    "$ref": "#/$defs/id"
                },
                "proposal_hash": {
                    "$ref": "#/$defs/sha256"
                },
                "recovery_ref": {
                    "$ref": "#/$defs/path"
                }
            },
            "allOf": [
                {
                    "if": {
                        "required": [
                            "action"
                        ],
                        "properties": {
                            "action": {
                                "enum": [
                                    "bind",
                                    "takeover"
                                ]
                            }
                        }
                    },
                    "then": {
                        "required": [
                            "operation_id",
                            "proposal_hash",
                            "target_kinds"
                        ],
                        "properties": {
                            "target_kinds": {
                                "minItems": 1
                            }
                        }
                    },
                    "else": {
                        "not": {
                            "anyOf": [
                                {
                                    "required": [
                                        "operation_id"
                                    ]
                                },
                                {
                                    "required": [
                                        "proposal_hash"
                                    ]
                                }
                            ]
                        }
                    }
                },
                {
                    "if": {
                        "required": [
                            "action"
                        ],
                        "properties": {
                            "action": {
                                "const": "takeover"
                            }
                        }
                    },
                    "then": {
                        "required": [
                            "recovery_ref"
                        ]
                    },
                    "else": {
                        "not": {
                            "required": [
                                "recovery_ref"
                            ]
                        }
                    }
                }
            ]
        },
        "retryOf": {
            "type": [
                "object",
                "null"
            ],
            "additionalProperties": false,
            "required": [
                "dispatch_id",
                "attempt_id",
                "recovery_ref"
            ],
            "properties": {
                "dispatch_id": {
                    "$ref": "#/$defs/dispatchId"
                },
                "attempt_id": {
                    "$ref": "#/$defs/attemptId"
                },
                "recovery_ref": {
                    "$ref": "#/$defs/path"
                }
            }
        },
        "dispatchInput": {
            "type": "object",
            "additionalProperties": false,
            "required": [
                "project_root",
                "operation_id",
                "post_id",
                "route_id",
                "target_ids",
                "objective",
                "evidence_required",
                "prohibited"
            ],
            "properties": {
                "project_root": {
                    "$ref": "#/$defs/root"
                },
                "operation_id": {
                    "$ref": "#/$defs/id"
                },
                "post_id": {
                    "$ref": "#/$defs/id"
                },
                "route_id": {
                    "$ref": "#/$defs/routeId"
                },
                "target_ids": {
                    "type": "array",
                    "minItems": 1,
                    "uniqueItems": true,
                    "items": {
                        "type": "string",
                        "pattern": "^T-[A-Za-z0-9_-]+$"
                    }
                },
                "objective": {
                    "$ref": "#/$defs/text"
                },
                "evidence_required": {
                    "type": "array",
                    "minItems": 1,
                    "uniqueItems": true,
                    "items": {
                        "$ref": "#/$defs/anchorKind"
                    }
                },
                "prohibited": {
                    "$ref": "#/$defs/strings"
                },
                "capability_needs": {
                    "$ref": "#/$defs/strings",
                    "default": []
                },
                "depends_on_tasks": {
                    "$ref": "#/$defs/strings",
                    "default": []
                },
                "resource_needs": {
                    "type": "array",
                    "items": {
                        "$ref": "#/$defs/resource"
                    },
                    "default": []
                },
                "timebox_ms": {
                    "type": "integer",
                    "minimum": 1,
                    "default": 1800000
                },
                "delivery_timeout_ms": {
                    "type": "integer",
                    "minimum": 1,
                    "default": 60000
                },
                "retry_of": {
                    "$ref": "#/$defs/retryOf",
                    "default": null
                }
            }
        },
        "review": {
            "type": "object",
            "additionalProperties": false,
            "required": [
                "outcome",
                "summary",
                "reason",
                "proposed_route_status",
                "evidence_run_ids",
                "anchor_refs",
                "limitations",
                "next_step"
            ],
            "properties": {
                "outcome": {
                    "$ref": "#/$defs/outcome"
                },
                "summary": {
                    "$ref": "#/$defs/text"
                },
                "reason": {
                    "$ref": "#/$defs/text"
                },
                "proposed_route_status": {
                    "$ref": "#/$defs/routeStatus"
                },
                "evidence_run_ids": {
                    "type": "array",
                    "uniqueItems": true,
                    "items": {
                        "$ref": "#/$defs/runId"
                    }
                },
                "anchor_refs": {
                    "type": "array",
                    "items": {
                        "$ref": "#/$defs/anchorRef"
                    }
                },
                "limitations": {
                    "$ref": "#/$defs/strings"
                },
                "next_step": {
                    "type": [
                        "string",
                        "null"
                    ]
                }
            },
            "allOf": [
                {
                    "if": {
                        "properties": {
                            "outcome": {
                                "enum": [
                                    "finding",
                                    "no_finding",
                                    "refuted",
                                    "failed"
                                ]
                            }
                        }
                    },
                    "then": {
                        "properties": {
                            "evidence_run_ids": {
                                "minItems": 1
                            },
                            "anchor_refs": {
                                "minItems": 1
                            }
                        }
                    }
                },
                {
                    "if": {
                        "properties": {
                            "outcome": {
                                "const": "finding"
                            }
                        }
                    },
                    "then": {
                        "properties": {
                            "proposed_route_status": {
                                "enum": [
                                    "active",
                                    "validated"
                                ]
                            }
                        }
                    }
                },
                {
                    "if": {
                        "properties": {
                            "outcome": {
                                "const": "no_finding"
                            }
                        }
                    },
                    "then": {
                        "properties": {
                            "proposed_route_status": {
                                "enum": [
                                    "active",
                                    "paused",
                                    "validated"
                                ]
                            }
                        }
                    }
                },
                {
                    "if": {
                        "properties": {
                            "outcome": {
                                "const": "refuted"
                            }
                        }
                    },
                    "then": {
                        "properties": {
                            "proposed_route_status": {
                                "const": "falsified"
                            }
                        }
                    }
                },
                {
                    "if": {
                        "properties": {
                            "outcome": {
                                "const": "blocked"
                            }
                        }
                    },
                    "then": {
                        "properties": {
                            "proposed_route_status": {
                                "const": "blocked"
                            },
                            "next_step": {
                                "$ref": "#/$defs/text"
                            }
                        }
                    }
                },
                {
                    "if": {
                        "properties": {
                            "outcome": {
                                "const": "budget_exhausted"
                            }
                        }
                    },
                    "then": {
                        "properties": {
                            "proposed_route_status": {
                                "const": "paused"
                            },
                            "next_step": {
                                "$ref": "#/$defs/text"
                            }
                        }
                    }
                },
                {
                    "if": {
                        "properties": {
                            "outcome": {
                                "const": "failed"
                            }
                        }
                    },
                    "then": {
                        "properties": {
                            "proposed_route_status": {
                                "enum": [
                                    "blocked",
                                    "paused"
                                ]
                            },
                            "next_step": {
                                "$ref": "#/$defs/text"
                            }
                        }
                    }
                },
                {
                    "if": {
                        "properties": {
                            "outcome": {
                                "const": "cancelled"
                            }
                        }
                    },
                    "then": {
                        "properties": {
                            "proposed_route_status": {
                                "enum": [
                                    "paused",
                                    "superseded"
                                ]
                            },
                            "next_step": {
                                "$ref": "#/$defs/text"
                            }
                        }
                    }
                }
            ]
        },
        "concludeInput": {
            "type": "object",
            "additionalProperties": false,
            "required": [
                "project_root",
                "operation_id",
                "dispatch_id",
                "attempt_id",
                "task_id",
                "expected_revision",
                "submission_ref",
                "submission_sha256",
                "review"
            ],
            "properties": {
                "project_root": {
                    "$ref": "#/$defs/root"
                },
                "operation_id": {
                    "$ref": "#/$defs/id"
                },
                "dispatch_id": {
                    "$ref": "#/$defs/dispatchId"
                },
                "attempt_id": {
                    "$ref": "#/$defs/attemptId"
                },
                "task_id": {
                    "$ref": "#/$defs/text"
                },
                "expected_revision": {
                    "type": "integer",
                    "minimum": 0
                },
                "submission_ref": {
                    "$ref": "#/$defs/path"
                },
                "submission_sha256": {
                    "$ref": "#/$defs/sha256"
                },
                "review": {
                    "$ref": "#/$defs/review"
                }
            }
        },
        "request": {
            "type": "object",
            "additionalProperties": false,
            "required": [
                "tool",
                "input"
            ],
            "properties": {
                "tool": {
                    "enum": [
                        "rt_roster",
                        "rt_dispatch",
                        "rt_conclude"
                    ]
                },
                "input": {
                    "type": "object"
                }
            },
            "allOf": [
                {
                    "if": {
                        "properties": {
                            "tool": {
                                "const": "rt_roster"
                            }
                        }
                    },
                    "then": {
                        "properties": {
                            "input": {
                                "$ref": "#/$defs/rosterInput"
                            }
                        }
                    }
                },
                {
                    "if": {
                        "properties": {
                            "tool": {
                                "const": "rt_dispatch"
                            }
                        }
                    },
                    "then": {
                        "properties": {
                            "input": {
                                "$ref": "#/$defs/dispatchInput"
                            }
                        }
                    }
                },
                {
                    "if": {
                        "properties": {
                            "tool": {
                                "const": "rt_conclude"
                            }
                        }
                    },
                    "then": {
                        "properties": {
                            "input": {
                                "$ref": "#/$defs/concludeInput"
                            }
                        }
                    }
                }
            ]
        },
        "diagnostic": {
            "type": "object",
            "additionalProperties": false,
            "required": [
                "code",
                "reason",
                "next_step"
            ],
            "properties": {
                "code": {
                    "$ref": "#/$defs/text"
                },
                "reason": {
                    "$ref": "#/$defs/text"
                },
                "next_step": {
                    "$ref": "#/$defs/text"
                }
            }
        },
        "failureData": {
            "type": "object",
            "additionalProperties": false,
            "required": [
                "phase"
            ],
            "properties": {
                "phase": {
                    "enum": [
                        "preflight",
                        "prepared",
                        "member_ready",
                        "task_created",
                        "assigned",
                        "delivered",
                        "integrating",
                        "facts_committed",
                        "needs_recovery"
                    ]
                },
                "dispatch_id": {
                    "$ref": "#/$defs/dispatchId"
                },
                "attempt_id": {
                    "$ref": "#/$defs/attemptId"
                },
                "task_id": {
                    "$ref": "#/$defs/text"
                },
                "member": {
                    "$ref": "#/$defs/text"
                },
                "route_id": {
                    "$ref": "#/$defs/routeId"
                },
                "actual_revision": {
                    "type": "integer",
                    "minimum": 0
                },
                "contract_ref": {
                    "$ref": "#/$defs/path"
                },
                "work_dir": {
                    "$ref": "#/$defs/path"
                },
                "receipt_ref": {
                    "$ref": "#/$defs/path"
                },
                "recovery_ref": {
                    "$ref": "#/$defs/path"
                }
            }
        },
        "result": {
            "type": "object",
            "additionalProperties": false,
            "required": [
                "schema_version",
                "status",
                "code",
                "operation_id",
                "replayed",
                "retryable",
                "diagnostics",
                "data"
            ],
            "properties": {
                "schema_version": {
                    "const": 1
                },
                "status": {
                    "enum": [
                        "ok",
                        "blocked",
                        "partial",
                        "error"
                    ]
                },
                "code": {
                    "type": [
                        "string",
                        "null"
                    ]
                },
                "operation_id": {
                    "anyOf": [
                        {
                            "$ref": "#/$defs/id"
                        },
                        {
                            "type": "null"
                        }
                    ]
                },
                "replayed": {
                    "type": "boolean"
                },
                "retryable": {
                    "type": "boolean"
                },
                "diagnostics": {
                    "type": "array",
                    "items": {
                        "$ref": "#/$defs/diagnostic"
                    }
                },
                "data": {
                    "type": [
                        "object",
                        "null"
                    ]
                }
            },
            "allOf": [
                {
                    "if": {
                        "properties": {
                            "status": {
                                "const": "ok"
                            }
                        }
                    },
                    "then": {
                        "properties": {
                            "code": {
                                "const": null
                            },
                            "data": {
                                "type": "object"
                            }
                        }
                    },
                    "else": {
                        "properties": {
                            "code": {
                                "$ref": "#/$defs/errorCode"
                            },
                            "diagnostics": {
                                "minItems": 1
                            },
                            "data": {
                                "anyOf": [
                                    {
                                        "$ref": "#/$defs/failureData"
                                    },
                                    {
                                        "$ref": "#/$defs/rosterData"
                                    },
                                    {
                                        "type": "null"
                                    }
                                ]
                            }
                        }
                    }
                }
            ]
        },
        "post": {
            "type": "object",
            "additionalProperties": false,
            "required": [
                "post_id",
                "state",
                "required",
                "optional",
                "anchors_required",
                "member",
                "reason"
            ],
            "properties": {
                "post_id": {
                    "$ref": "#/$defs/id"
                },
                "state": {
                    "enum": [
                        "ready",
                        "assigned",
                        "vacant",
                        "deferred",
                        "disabled"
                    ]
                },
                "required": {
                    "$ref": "#/$defs/strings"
                },
                "optional": {
                    "$ref": "#/$defs/strings"
                },
                "anchors_required": {
                    "type": "array",
                    "items": {
                        "$ref": "#/$defs/anchorKind"
                    }
                },
                "member": {
                    "type": [
                        "string",
                        "null"
                    ]
                },
                "reason": {
                    "$ref": "#/$defs/text"
                }
            }
        },
        "rosterData": {
            "type": "object",
            "additionalProperties": false,
            "required": [
                "action",
                "project_root",
                "project_id",
                "session_id",
                "team_id",
                "compatibility",
                "posts",
                "gaps",
                "proposal_hash",
                "binding_ref"
            ],
            "properties": {
                "action": {
                    "enum": [
                        "inspect",
                        "bind",
                        "takeover"
                    ]
                },
                "project_root": {
                    "$ref": "#/$defs/root"
                },
                "project_id": {
                    "type": [
                        "string",
                        "null"
                    ]
                },
                "session_id": {
                    "type": [
                        "string",
                        "null"
                    ]
                },
                "team_id": {
                    "type": [
                        "string",
                        "null"
                    ]
                },
                "compatibility": {
                    "enum": [
                        "compatible",
                        "blocked",
                        "unknown"
                    ]
                },
                "posts": {
                    "type": "array",
                    "items": {
                        "$ref": "#/$defs/post"
                    }
                },
                "gaps": {
                    "type": "array",
                    "items": {
                        "$ref": "#/$defs/diagnostic"
                    }
                },
                "proposal_hash": {
                    "anyOf": [
                        {
                            "$ref": "#/$defs/sha256"
                        },
                        {
                            "type": "null"
                        }
                    ]
                },
                "binding_ref": {
                    "anyOf": [
                        {
                            "$ref": "#/$defs/path"
                        },
                        {
                            "type": "null"
                        }
                    ]
                }
            }
        },
        "dispatchData": {
            "type": "object",
            "additionalProperties": false,
            "required": [
                "dispatch_id",
                "attempt_id",
                "task_id",
                "member",
                "route_id",
                "revision",
                "phase",
                "contract_ref",
                "work_dir",
                "started_at"
            ],
            "properties": {
                "dispatch_id": {
                    "$ref": "#/$defs/dispatchId"
                },
                "attempt_id": {
                    "$ref": "#/$defs/attemptId"
                },
                "task_id": {
                    "$ref": "#/$defs/text"
                },
                "member": {
                    "$ref": "#/$defs/text"
                },
                "route_id": {
                    "$ref": "#/$defs/routeId"
                },
                "revision": {
                    "type": "integer",
                    "minimum": 0
                },
                "phase": {
                    "const": "delivered"
                },
                "contract_ref": {
                    "$ref": "#/$defs/path"
                },
                "work_dir": {
                    "$ref": "#/$defs/path"
                },
                "started_at": {
                    "anyOf": [
                        {
                            "$ref": "#/$defs/date"
                        },
                        {
                            "type": "null"
                        }
                    ]
                }
            }
        },
        "concludeData": {
            "type": "object",
            "additionalProperties": false,
            "required": [
                "dispatch_id",
                "attempt_id",
                "task_id",
                "phase",
                "outcome",
                "route_status",
                "receipt_ref",
                "checks",
                "audit_written"
            ],
            "properties": {
                "dispatch_id": {
                    "$ref": "#/$defs/dispatchId"
                },
                "attempt_id": {
                    "$ref": "#/$defs/attemptId"
                },
                "task_id": {
                    "$ref": "#/$defs/text"
                },
                "phase": {
                    "const": "completed"
                },
                "outcome": {
                    "$ref": "#/$defs/outcome"
                },
                "route_status": {
                    "$ref": "#/$defs/routeStatus"
                },
                "receipt_ref": {
                    "$ref": "#/$defs/path"
                },
                "audit_written": {
                    "type": "boolean"
                },
                "checks": {
                    "type": "array",
                    "minItems": 1,
                    "items": {
                        "type": "object",
                        "additionalProperties": false,
                        "required": [
                            "name",
                            "status",
                            "output_ref",
                            "exit_code"
                        ],
                        "properties": {
                            "name": {
                                "$ref": "#/$defs/text"
                            },
                            "status": {
                                "const": "pass"
                            },
                            "output_ref": {
                                "$ref": "#/$defs/path"
                            },
                            "exit_code": {
                                "type": [
                                    "integer",
                                    "null"
                                ]
                            }
                        }
                    }
                }
            }
        },
        "response": {
            "type": "object",
            "additionalProperties": false,
            "required": [
                "tool",
                "output"
            ],
            "properties": {
                "tool": {
                    "enum": [
                        "rt_roster",
                        "rt_dispatch",
                        "rt_conclude"
                    ]
                },
                "output": {
                    "$ref": "#/$defs/result"
                }
            },
            "allOf": [
                {
                    "if": {
                        "properties": {
                            "tool": {
                                "const": "rt_roster"
                            },
                            "output": {
                                "properties": {
                                    "status": {
                                        "const": "ok"
                                    }
                                }
                            }
                        }
                    },
                    "then": {
                        "properties": {
                            "output": {
                                "properties": {
                                    "data": {
                                        "$ref": "#/$defs/rosterData"
                                    }
                                }
                            }
                        }
                    }
                },
                {
                    "if": {
                        "properties": {
                            "tool": {
                                "const": "rt_dispatch"
                            },
                            "output": {
                                "properties": {
                                    "status": {
                                        "const": "ok"
                                    }
                                }
                            }
                        }
                    },
                    "then": {
                        "properties": {
                            "output": {
                                "properties": {
                                    "data": {
                                        "$ref": "#/$defs/dispatchData"
                                    }
                                }
                            }
                        }
                    }
                },
                {
                    "if": {
                        "properties": {
                            "tool": {
                                "const": "rt_conclude"
                            },
                            "output": {
                                "properties": {
                                    "status": {
                                        "const": "ok"
                                    }
                                }
                            }
                        }
                    },
                    "then": {
                        "properties": {
                            "output": {
                                "properties": {
                                    "data": {
                                        "$ref": "#/$defs/concludeData"
                                    }
                                }
                            }
                        }
                    }
                }
            ]
        }
    }
};
/**
 * 规格的 `$defs` 映射，可直接交给 `validate.validateInput(schemaDefs, defName, value)`。
 * @type {Record<string, object>}
 */
export const schemaDefs = SPEC.$defs;
/** `rt_roster` 入参（校验由本包自己做：raw JSON Schema 的工具没有宿主侧自动校验）。 */
export const rosterInput = schemaDefs.rosterInput;
/** `rt_dispatch` 入参。 */
export const dispatchInput = schemaDefs.dispatchInput;
/** `rt_conclude` 入参。 */
export const concludeInput = schemaDefs.concludeInput;
/** 三个工具共用的返回信封（`$defs.result`）：`execute` 的返回值必须符合它。 */
export const result = schemaDefs.result;
/** 三个工具的成功 data 形状（handler 与测试共用，避免手写重复）。 */
export const rosterData = schemaDefs.rosterData;
export const dispatchData = schemaDefs.dispatchData;
export const concludeData = schemaDefs.concludeData;
/** 失败 data 与诊断的共用定义。 */
export const failureData = schemaDefs.failureData;
export const diagnostic = schemaDefs.diagnostic;
/** `$defs.errorCode` 的闭集（稳定错误码）。 */
export const errorCodes = schemaDefs.errorCode.enum;
// ---------------------------------------------------------------------------
// 注册用的两个投影（**不是**规格数据；与规格的一致性由 test/bundle.test.mjs 钉住）
// ---------------------------------------------------------------------------
/**
 * 把 `$ref: '#/$defs/<name>'` 就地展开，得到**自包含**的 schema（同层兄弟关键字叠加到展开结果上）。
 *
 * 为什么需要：工具 `parameters` 是直接进模型上下文的原始 JSON Schema。规格副本里的
 * `$ref` 指向 `#/$defs/...`，如果不同时把整份 `$defs` 塞进去，它们就是悬空引用
 * （模型与严格的 provider 都解析不了）。就地展开比塞整份 `$defs` 更小、也更可读。
 *
 * @param {unknown} schema 规格里的 schema 节点
 * @param {Record<string, object>} [defs] `$defs` 映射
 * @param {number} [depth] 递归深度（防环）
 * @returns {unknown} 展开后的新对象（不改原 schema）
 */
export function inlineRefs(schema, defs = schemaDefs, depth = 0) {
    if (depth > 64)
        throw new TypeError('schema $ref 展开过深（规格里不应有环）');
    if (Array.isArray(schema))
        return schema.map((item) => inlineRefs(item, defs, depth + 1));
    if (schema === null || typeof schema !== 'object')
        return schema;
    const view = recordOf(schema);
    if (typeof view.$ref === 'string') {
        const match = /^#\/\$defs\/([^/]+)$/.exec(view.$ref);
        if (match === null)
            throw new TypeError(`不支持的 $ref：${view.$ref}`);
        const target = defs[match[1]];
        if (target === undefined)
            throw new TypeError(`$ref 指向未定义的定义：${view.$ref}`);
        const { $ref: _ignored, ...siblings } = view;
        return inlineRefs({ ...recordOf(target), ...siblings }, defs, depth + 1);
    }
    const out = {};
    for (const [key, value] of Object.entries(view))
        out[key] = inlineRefs(value, defs, depth + 1);
    return out;
}
/** `rt_roster` 的注册用入参 schema（自包含，无 `$ref`）。 */
export const rosterParameters = inlineRefs(rosterInput);
/** `rt_dispatch` 的注册用入参 schema。 */
export const dispatchParameters = inlineRefs(dispatchInput);
/** `rt_conclude` 的注册用入参 schema。 */
export const concludeParameters = inlineRefs(concludeInput);
/**
 * `output.schema` 的唯一合法形态：**宿主支持子集**里的 `$defs.result` 投影。
 *
 * 宿主 `ctx.tools.register()` 会用 `assertSupportedJsonSchema`
 * （`packages/core/tools/src/json-schema.ts`，见 E1 §C.2）校验 `output.schema`，而这个子集只有
 * `type` / `oneOf` / `properties` / `required` / `additionalProperties` / `items` / `enum` / `const`
 * 加注解（description/title/default/examples）。以下写法会让注册**直接抛**
 * `UNSUPPORTED_SCHEMA`、整行插件不激活：
 *
 * - `$ref` / `$defs`（规格里到处都是，所以 `$defs.result` 不能直接注册）；
 * - `allOf` / `anyOf` / `not` / `if-then-else`（`result` 的 `ok ⇒ code=null` 条件分支就在这里）；
 * - `type: ['string','null']` 这类**类型数组**、`pattern`、`minLength`、`minimum`、`format`。
 *
 * 因此这里给出投影：结构（八个字段、required、封闭）与 `$defs.result` 逐项一致；类型联合写成
 * `oneOf`；`enum` 直接取自 `$defs.errorCode`，不另抄一份。表达不了的条件约束
 * （`ok ⇒ code=null`、非 ok 的 data 必须是 failureData/rosterData）由
 * `src/envelope.mjs` 的构造器与 `index.js` 的严格校验（完整 JSON Schema，含 if/then/else）保证 ——
 * 宿主这层只当结构安全网。
 */
export const resultOutput = {
    type: 'object',
    additionalProperties: false,
    required: [
        'schema_version',
        'status',
        'code',
        'operation_id',
        'replayed',
        'retryable',
        'diagnostics',
        'data',
    ],
    properties: {
        schema_version: { type: 'integer', const: 1, description: '工具契约版本，恒为 1。' },
        status: {
            type: 'string',
            enum: ['ok', 'blocked', 'partial', 'error'],
            description: 'ok 成功；blocked 前置拒绝；partial 副作用可能已发生；error 非法参数/角色或未捕获异常。',
        },
        code: {
            oneOf: [{ type: 'string', enum: [...errorCodes] }, { type: 'null' }],
            description: 'ok 时必须为 null；其余取 $defs.errorCode 的稳定码。',
        },
        operation_id: {
            oneOf: [{ type: 'string' }, { type: 'null' }],
            description: '本次操作的 operation id；不涉及操作时为 null。',
        },
        replayed: { type: 'boolean', description: '是否为同一 operation 的重放结果。' },
        retryable: { type: 'boolean', description: '是否允许以同一 operation_id 重入（不代表自动重试）。' },
        diagnostics: {
            type: 'array',
            description: '每条诊断都必须给出原因与具体下一步。',
            items: {
                type: 'object',
                additionalProperties: false,
                required: ['code', 'reason', 'next_step'],
                properties: {
                    code: { type: 'string' },
                    reason: { type: 'string' },
                    next_step: { type: 'string' },
                },
            },
        },
        data: {
            oneOf: [{ type: 'object' }, { type: 'null' }],
            description: 'ok 时为对应工具的成功 data；非 ok 时为 failureData / rosterData / null。',
        },
    },
};
