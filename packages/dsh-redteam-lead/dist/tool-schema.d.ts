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
/**
 * 规格的 `$defs` 映射，可直接交给 `validate.validateInput(schemaDefs, defName, value)`。
 * @type {Record<string, object>}
 */
export declare const schemaDefs: {
    text: {
        type: string;
        minLength: number;
        pattern: string;
    };
    id: {
        type: string;
        pattern: string;
    };
    sha256: {
        type: string;
        pattern: string;
    };
    path: {
        type: string;
        minLength: number;
        description: string;
    };
    root: {
        type: string;
        minLength: number;
        description: string;
    };
    routeId: {
        type: string;
        pattern: string;
    };
    runId: {
        type: string;
        pattern: string;
    };
    dispatchId: {
        type: string;
        pattern: string;
    };
    attemptId: {
        type: string;
        pattern: string;
    };
    strings: {
        type: string;
        items: {
            $ref: string;
        };
        uniqueItems: boolean;
    };
    kinds: {
        type: string;
        items: {
            enum: string[];
        };
        uniqueItems: boolean;
    };
    date: {
        type: string;
        format: string;
    };
    routeStatus: {
        enum: string[];
    };
    outcome: {
        enum: string[];
    };
    errorCode: {
        enum: string[];
    };
    anchorKind: {
        enum: string[];
    };
    resource: {
        type: string;
        additionalProperties: boolean;
        required: string[];
        properties: {
            resource_key: {
                $ref: string;
            };
            mode: {
                enum: string[];
            };
        };
    };
    anchorRef: {
        type: string;
        additionalProperties: boolean;
        required: string[];
        properties: {
            kind: {
                $ref: string;
            };
            run_id: {
                $ref: string;
            };
            path: {
                $ref: string;
            };
            locator: {
                $ref: string;
            };
        };
    };
    rosterInput: {
        type: string;
        additionalProperties: boolean;
        required: string[];
        properties: {
            project_root: {
                $ref: string;
            };
            action: {
                enum: string[];
                default: string;
            };
            target_kinds: {
                $ref: string;
                default: never[];
            };
            max_posts: {
                type: string;
                minimum: number;
                default: number;
            };
            reserved_member_slots: {
                type: string;
                minimum: number;
                default: number;
            };
            reserved_activations: {
                type: string;
                minimum: number;
                default: number;
            };
            capacity: {
                type: string;
                additionalProperties: boolean;
                required: string[];
                properties: {
                    max_members: {
                        type: string;
                        minimum: number;
                    };
                    max_active_subagents: {
                        type: string;
                        minimum: number;
                    };
                };
            };
            operation_id: {
                $ref: string;
            };
            proposal_hash: {
                $ref: string;
            };
            recovery_ref: {
                $ref: string;
            };
        };
        allOf: ({
            if: {
                required: string[];
                properties: {
                    action: {
                        enum: string[];
                        const?: undefined;
                    };
                };
            };
            then: {
                required: string[];
                properties: {
                    target_kinds: {
                        minItems: number;
                    };
                };
            };
            else: {
                not: {
                    anyOf: {
                        required: string[];
                    }[];
                    required?: undefined;
                };
            };
        } | {
            if: {
                required: string[];
                properties: {
                    action: {
                        const: string;
                        enum?: undefined;
                    };
                };
            };
            then: {
                required: string[];
                properties?: undefined;
            };
            else: {
                not: {
                    required: string[];
                    anyOf?: undefined;
                };
            };
        })[];
    };
    retryOf: {
        type: string[];
        additionalProperties: boolean;
        required: string[];
        properties: {
            dispatch_id: {
                $ref: string;
            };
            attempt_id: {
                $ref: string;
            };
            recovery_ref: {
                $ref: string;
            };
        };
    };
    dispatchInput: {
        type: string;
        additionalProperties: boolean;
        required: string[];
        properties: {
            project_root: {
                $ref: string;
            };
            operation_id: {
                $ref: string;
            };
            post_id: {
                $ref: string;
            };
            route_id: {
                $ref: string;
            };
            target_ids: {
                type: string;
                minItems: number;
                uniqueItems: boolean;
                items: {
                    type: string;
                    pattern: string;
                };
            };
            objective: {
                $ref: string;
            };
            evidence_required: {
                type: string;
                minItems: number;
                uniqueItems: boolean;
                items: {
                    $ref: string;
                };
            };
            prohibited: {
                $ref: string;
            };
            capacity: {
                type: string;
                additionalProperties: boolean;
                required: string[];
                properties: {
                    max_members: {
                        type: string;
                        minimum: number;
                    };
                    max_active_subagents: {
                        type: string;
                        minimum: number;
                    };
                };
            };
            capability_needs: {
                $ref: string;
                default: never[];
            };
            depends_on_tasks: {
                $ref: string;
                default: never[];
            };
            resource_needs: {
                type: string;
                items: {
                    $ref: string;
                };
                default: never[];
            };
            timebox_ms: {
                type: string;
                minimum: number;
                default: number;
            };
            delivery_timeout_ms: {
                type: string;
                minimum: number;
                default: number;
            };
            retry_of: {
                $ref: string;
                default: null;
            };
        };
    };
    review: {
        type: string;
        additionalProperties: boolean;
        required: string[];
        properties: {
            outcome: {
                $ref: string;
            };
            summary: {
                $ref: string;
            };
            reason: {
                $ref: string;
            };
            proposed_route_status: {
                $ref: string;
            };
            evidence_run_ids: {
                type: string;
                uniqueItems: boolean;
                items: {
                    $ref: string;
                };
            };
            anchor_refs: {
                type: string;
                items: {
                    $ref: string;
                };
            };
            limitations: {
                $ref: string;
            };
            next_step: {
                type: string[];
            };
        };
        allOf: ({
            if: {
                properties: {
                    outcome: {
                        enum: string[];
                        const?: undefined;
                    };
                };
            };
            then: {
                properties: {
                    evidence_run_ids: {
                        minItems: number;
                    };
                    anchor_refs: {
                        minItems: number;
                    };
                    proposed_route_status?: undefined;
                    next_step?: undefined;
                };
            };
        } | {
            if: {
                properties: {
                    outcome: {
                        const: string;
                        enum?: undefined;
                    };
                };
            };
            then: {
                properties: {
                    proposed_route_status: {
                        enum: string[];
                        const?: undefined;
                    };
                    evidence_run_ids?: undefined;
                    anchor_refs?: undefined;
                    next_step?: undefined;
                };
            };
        } | {
            if: {
                properties: {
                    outcome: {
                        const: string;
                        enum?: undefined;
                    };
                };
            };
            then: {
                properties: {
                    proposed_route_status: {
                        const: string;
                        enum?: undefined;
                    };
                    evidence_run_ids?: undefined;
                    anchor_refs?: undefined;
                    next_step?: undefined;
                };
            };
        } | {
            if: {
                properties: {
                    outcome: {
                        const: string;
                        enum?: undefined;
                    };
                };
            };
            then: {
                properties: {
                    proposed_route_status: {
                        const: string;
                        enum?: undefined;
                    };
                    next_step: {
                        $ref: string;
                    };
                    evidence_run_ids?: undefined;
                    anchor_refs?: undefined;
                };
            };
        } | {
            if: {
                properties: {
                    outcome: {
                        const: string;
                        enum?: undefined;
                    };
                };
            };
            then: {
                properties: {
                    proposed_route_status: {
                        enum: string[];
                        const?: undefined;
                    };
                    next_step: {
                        $ref: string;
                    };
                    evidence_run_ids?: undefined;
                    anchor_refs?: undefined;
                };
            };
        })[];
    };
    concludeInput: {
        type: string;
        additionalProperties: boolean;
        required: string[];
        properties: {
            project_root: {
                $ref: string;
            };
            operation_id: {
                $ref: string;
            };
            dispatch_id: {
                $ref: string;
            };
            attempt_id: {
                $ref: string;
            };
            task_id: {
                $ref: string;
            };
            expected_revision: {
                type: string;
                minimum: number;
            };
            submission_ref: {
                $ref: string;
            };
            submission_sha256: {
                $ref: string;
            };
            review: {
                $ref: string;
            };
        };
    };
    request: {
        type: string;
        additionalProperties: boolean;
        required: string[];
        properties: {
            tool: {
                enum: string[];
            };
            input: {
                type: string;
            };
        };
        allOf: {
            if: {
                properties: {
                    tool: {
                        const: string;
                    };
                };
            };
            then: {
                properties: {
                    input: {
                        $ref: string;
                    };
                };
            };
        }[];
    };
    diagnostic: {
        type: string;
        additionalProperties: boolean;
        required: string[];
        properties: {
            code: {
                $ref: string;
            };
            reason: {
                $ref: string;
            };
            next_step: {
                $ref: string;
            };
        };
    };
    failureData: {
        type: string;
        additionalProperties: boolean;
        required: string[];
        properties: {
            phase: {
                enum: string[];
            };
            dispatch_id: {
                $ref: string;
            };
            attempt_id: {
                $ref: string;
            };
            task_id: {
                $ref: string;
            };
            member: {
                $ref: string;
            };
            route_id: {
                $ref: string;
            };
            actual_revision: {
                type: string;
                minimum: number;
            };
            contract_ref: {
                $ref: string;
            };
            work_dir: {
                $ref: string;
            };
            receipt_ref: {
                $ref: string;
            };
            recovery_ref: {
                $ref: string;
            };
        };
    };
    result: {
        type: string;
        additionalProperties: boolean;
        required: string[];
        properties: {
            schema_version: {
                const: number;
            };
            status: {
                enum: string[];
            };
            code: {
                type: string[];
            };
            operation_id: {
                anyOf: ({
                    $ref: string;
                    type?: undefined;
                } | {
                    type: string;
                    $ref?: undefined;
                })[];
            };
            replayed: {
                type: string;
            };
            retryable: {
                type: string;
            };
            diagnostics: {
                type: string;
                items: {
                    $ref: string;
                };
            };
            data: {
                type: string[];
            };
        };
        allOf: {
            if: {
                properties: {
                    status: {
                        const: string;
                    };
                };
            };
            then: {
                properties: {
                    code: {
                        const: null;
                    };
                    data: {
                        type: string;
                    };
                };
            };
            else: {
                properties: {
                    code: {
                        $ref: string;
                    };
                    diagnostics: {
                        minItems: number;
                    };
                    data: {
                        anyOf: ({
                            $ref: string;
                            type?: undefined;
                        } | {
                            type: string;
                            $ref?: undefined;
                        })[];
                    };
                };
            };
        }[];
    };
    post: {
        type: string;
        additionalProperties: boolean;
        required: string[];
        properties: {
            post_id: {
                $ref: string;
            };
            state: {
                enum: string[];
            };
            required: {
                $ref: string;
            };
            optional: {
                $ref: string;
            };
            anchors_required: {
                type: string;
                items: {
                    $ref: string;
                };
            };
            member: {
                type: string[];
            };
            reason: {
                $ref: string;
            };
        };
    };
    rosterData: {
        type: string;
        additionalProperties: boolean;
        required: string[];
        properties: {
            action: {
                enum: string[];
            };
            project_root: {
                $ref: string;
            };
            project_id: {
                type: string[];
            };
            session_id: {
                type: string[];
            };
            team_id: {
                type: string[];
            };
            compatibility: {
                enum: string[];
            };
            posts: {
                type: string;
                items: {
                    $ref: string;
                };
            };
            gaps: {
                type: string;
                items: {
                    $ref: string;
                };
            };
            capacity: {
                type: string;
                additionalProperties: boolean;
                required: string[];
                properties: {
                    remaining_member_slots: {
                        type: string[];
                        minimum: number;
                    };
                    remaining_activations: {
                        type: string[];
                        minimum: number;
                    };
                    reserved_member_slots: {
                        type: string;
                        minimum: number;
                    };
                    reserved_activations: {
                        type: string;
                        minimum: number;
                    };
                };
            };
            recommended_members: {
                type: string;
                minimum: number;
            };
            proposal_hash: {
                anyOf: ({
                    $ref: string;
                    type?: undefined;
                } | {
                    type: string;
                    $ref?: undefined;
                })[];
            };
            binding_ref: {
                anyOf: ({
                    $ref: string;
                    type?: undefined;
                } | {
                    type: string;
                    $ref?: undefined;
                })[];
            };
        };
    };
    dispatchData: {
        type: string;
        additionalProperties: boolean;
        required: string[];
        properties: {
            dispatch_id: {
                $ref: string;
            };
            attempt_id: {
                $ref: string;
            };
            task_id: {
                $ref: string;
            };
            member: {
                $ref: string;
            };
            route_id: {
                $ref: string;
            };
            revision: {
                type: string;
                minimum: number;
            };
            phase: {
                const: string;
            };
            contract_ref: {
                $ref: string;
            };
            work_dir: {
                $ref: string;
            };
            started_at: {
                anyOf: ({
                    $ref: string;
                    type?: undefined;
                } | {
                    type: string;
                    $ref?: undefined;
                })[];
            };
        };
    };
    concludeData: {
        type: string;
        additionalProperties: boolean;
        required: string[];
        properties: {
            dispatch_id: {
                $ref: string;
            };
            attempt_id: {
                $ref: string;
            };
            task_id: {
                $ref: string;
            };
            phase: {
                const: string;
            };
            outcome: {
                $ref: string;
            };
            route_status: {
                $ref: string;
            };
            receipt_ref: {
                $ref: string;
            };
            audit_written: {
                type: string;
            };
            checks: {
                type: string;
                minItems: number;
                items: {
                    type: string;
                    additionalProperties: boolean;
                    required: string[];
                    properties: {
                        name: {
                            $ref: string;
                        };
                        status: {
                            const: string;
                        };
                        output_ref: {
                            $ref: string;
                        };
                        exit_code: {
                            type: string[];
                        };
                    };
                };
            };
        };
    };
    response: {
        type: string;
        additionalProperties: boolean;
        required: string[];
        properties: {
            tool: {
                enum: string[];
            };
            output: {
                $ref: string;
            };
        };
        allOf: {
            if: {
                properties: {
                    tool: {
                        const: string;
                    };
                    output: {
                        properties: {
                            status: {
                                const: string;
                            };
                        };
                    };
                };
            };
            then: {
                properties: {
                    output: {
                        properties: {
                            data: {
                                $ref: string;
                            };
                        };
                    };
                };
            };
        }[];
    };
};
/** `rt_roster` 入参（校验由本包自己做：raw JSON Schema 的工具没有宿主侧自动校验）。 */
export declare const rosterInput: {
    type: string;
    additionalProperties: boolean;
    required: string[];
    properties: {
        project_root: {
            $ref: string;
        };
        action: {
            enum: string[];
            default: string;
        };
        target_kinds: {
            $ref: string;
            default: never[];
        };
        max_posts: {
            type: string;
            minimum: number;
            default: number;
        };
        reserved_member_slots: {
            type: string;
            minimum: number;
            default: number;
        };
        reserved_activations: {
            type: string;
            minimum: number;
            default: number;
        };
        capacity: {
            type: string;
            additionalProperties: boolean;
            required: string[];
            properties: {
                max_members: {
                    type: string;
                    minimum: number;
                };
                max_active_subagents: {
                    type: string;
                    minimum: number;
                };
            };
        };
        operation_id: {
            $ref: string;
        };
        proposal_hash: {
            $ref: string;
        };
        recovery_ref: {
            $ref: string;
        };
    };
    allOf: ({
        if: {
            required: string[];
            properties: {
                action: {
                    enum: string[];
                    const?: undefined;
                };
            };
        };
        then: {
            required: string[];
            properties: {
                target_kinds: {
                    minItems: number;
                };
            };
        };
        else: {
            not: {
                anyOf: {
                    required: string[];
                }[];
                required?: undefined;
            };
        };
    } | {
        if: {
            required: string[];
            properties: {
                action: {
                    const: string;
                    enum?: undefined;
                };
            };
        };
        then: {
            required: string[];
            properties?: undefined;
        };
        else: {
            not: {
                required: string[];
                anyOf?: undefined;
            };
        };
    })[];
};
/** `rt_dispatch` 入参。 */
export declare const dispatchInput: {
    type: string;
    additionalProperties: boolean;
    required: string[];
    properties: {
        project_root: {
            $ref: string;
        };
        operation_id: {
            $ref: string;
        };
        post_id: {
            $ref: string;
        };
        route_id: {
            $ref: string;
        };
        target_ids: {
            type: string;
            minItems: number;
            uniqueItems: boolean;
            items: {
                type: string;
                pattern: string;
            };
        };
        objective: {
            $ref: string;
        };
        evidence_required: {
            type: string;
            minItems: number;
            uniqueItems: boolean;
            items: {
                $ref: string;
            };
        };
        prohibited: {
            $ref: string;
        };
        capacity: {
            type: string;
            additionalProperties: boolean;
            required: string[];
            properties: {
                max_members: {
                    type: string;
                    minimum: number;
                };
                max_active_subagents: {
                    type: string;
                    minimum: number;
                };
            };
        };
        capability_needs: {
            $ref: string;
            default: never[];
        };
        depends_on_tasks: {
            $ref: string;
            default: never[];
        };
        resource_needs: {
            type: string;
            items: {
                $ref: string;
            };
            default: never[];
        };
        timebox_ms: {
            type: string;
            minimum: number;
            default: number;
        };
        delivery_timeout_ms: {
            type: string;
            minimum: number;
            default: number;
        };
        retry_of: {
            $ref: string;
            default: null;
        };
    };
};
/** `rt_conclude` 入参。 */
export declare const concludeInput: {
    type: string;
    additionalProperties: boolean;
    required: string[];
    properties: {
        project_root: {
            $ref: string;
        };
        operation_id: {
            $ref: string;
        };
        dispatch_id: {
            $ref: string;
        };
        attempt_id: {
            $ref: string;
        };
        task_id: {
            $ref: string;
        };
        expected_revision: {
            type: string;
            minimum: number;
        };
        submission_ref: {
            $ref: string;
        };
        submission_sha256: {
            $ref: string;
        };
        review: {
            $ref: string;
        };
    };
};
/** 三个工具共用的返回信封（`$defs.result`）：`execute` 的返回值必须符合它。 */
export declare const result: {
    type: string;
    additionalProperties: boolean;
    required: string[];
    properties: {
        schema_version: {
            const: number;
        };
        status: {
            enum: string[];
        };
        code: {
            type: string[];
        };
        operation_id: {
            anyOf: ({
                $ref: string;
                type?: undefined;
            } | {
                type: string;
                $ref?: undefined;
            })[];
        };
        replayed: {
            type: string;
        };
        retryable: {
            type: string;
        };
        diagnostics: {
            type: string;
            items: {
                $ref: string;
            };
        };
        data: {
            type: string[];
        };
    };
    allOf: {
        if: {
            properties: {
                status: {
                    const: string;
                };
            };
        };
        then: {
            properties: {
                code: {
                    const: null;
                };
                data: {
                    type: string;
                };
            };
        };
        else: {
            properties: {
                code: {
                    $ref: string;
                };
                diagnostics: {
                    minItems: number;
                };
                data: {
                    anyOf: ({
                        $ref: string;
                        type?: undefined;
                    } | {
                        type: string;
                        $ref?: undefined;
                    })[];
                };
            };
        };
    }[];
};
/** 三个工具的成功 data 形状（handler 与测试共用，避免手写重复）。 */
export declare const rosterData: {
    type: string;
    additionalProperties: boolean;
    required: string[];
    properties: {
        action: {
            enum: string[];
        };
        project_root: {
            $ref: string;
        };
        project_id: {
            type: string[];
        };
        session_id: {
            type: string[];
        };
        team_id: {
            type: string[];
        };
        compatibility: {
            enum: string[];
        };
        posts: {
            type: string;
            items: {
                $ref: string;
            };
        };
        gaps: {
            type: string;
            items: {
                $ref: string;
            };
        };
        capacity: {
            type: string;
            additionalProperties: boolean;
            required: string[];
            properties: {
                remaining_member_slots: {
                    type: string[];
                    minimum: number;
                };
                remaining_activations: {
                    type: string[];
                    minimum: number;
                };
                reserved_member_slots: {
                    type: string;
                    minimum: number;
                };
                reserved_activations: {
                    type: string;
                    minimum: number;
                };
            };
        };
        recommended_members: {
            type: string;
            minimum: number;
        };
        proposal_hash: {
            anyOf: ({
                $ref: string;
                type?: undefined;
            } | {
                type: string;
                $ref?: undefined;
            })[];
        };
        binding_ref: {
            anyOf: ({
                $ref: string;
                type?: undefined;
            } | {
                type: string;
                $ref?: undefined;
            })[];
        };
    };
};
export declare const dispatchData: {
    type: string;
    additionalProperties: boolean;
    required: string[];
    properties: {
        dispatch_id: {
            $ref: string;
        };
        attempt_id: {
            $ref: string;
        };
        task_id: {
            $ref: string;
        };
        member: {
            $ref: string;
        };
        route_id: {
            $ref: string;
        };
        revision: {
            type: string;
            minimum: number;
        };
        phase: {
            const: string;
        };
        contract_ref: {
            $ref: string;
        };
        work_dir: {
            $ref: string;
        };
        started_at: {
            anyOf: ({
                $ref: string;
                type?: undefined;
            } | {
                type: string;
                $ref?: undefined;
            })[];
        };
    };
};
export declare const concludeData: {
    type: string;
    additionalProperties: boolean;
    required: string[];
    properties: {
        dispatch_id: {
            $ref: string;
        };
        attempt_id: {
            $ref: string;
        };
        task_id: {
            $ref: string;
        };
        phase: {
            const: string;
        };
        outcome: {
            $ref: string;
        };
        route_status: {
            $ref: string;
        };
        receipt_ref: {
            $ref: string;
        };
        audit_written: {
            type: string;
        };
        checks: {
            type: string;
            minItems: number;
            items: {
                type: string;
                additionalProperties: boolean;
                required: string[];
                properties: {
                    name: {
                        $ref: string;
                    };
                    status: {
                        const: string;
                    };
                    output_ref: {
                        $ref: string;
                    };
                    exit_code: {
                        type: string[];
                    };
                };
            };
        };
    };
};
/** 失败 data 与诊断的共用定义。 */
export declare const failureData: {
    type: string;
    additionalProperties: boolean;
    required: string[];
    properties: {
        phase: {
            enum: string[];
        };
        dispatch_id: {
            $ref: string;
        };
        attempt_id: {
            $ref: string;
        };
        task_id: {
            $ref: string;
        };
        member: {
            $ref: string;
        };
        route_id: {
            $ref: string;
        };
        actual_revision: {
            type: string;
            minimum: number;
        };
        contract_ref: {
            $ref: string;
        };
        work_dir: {
            $ref: string;
        };
        receipt_ref: {
            $ref: string;
        };
        recovery_ref: {
            $ref: string;
        };
    };
};
export declare const diagnostic: {
    type: string;
    additionalProperties: boolean;
    required: string[];
    properties: {
        code: {
            $ref: string;
        };
        reason: {
            $ref: string;
        };
        next_step: {
            $ref: string;
        };
    };
};
/** `$defs.errorCode` 的闭集（稳定错误码）。 */
export declare const errorCodes: string[];
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
export declare function inlineRefs(schema: unknown, defs?: Record<string, unknown>, depth?: number): unknown;
/** `rt_roster` 的注册用入参 schema（自包含，无 `$ref`）。 */
export declare const rosterParameters: unknown;
/** `rt_dispatch` 的注册用入参 schema。 */
export declare const dispatchParameters: unknown;
/** `rt_conclude` 的注册用入参 schema。 */
export declare const concludeParameters: unknown;
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
export declare const resultOutput: {
    type: string;
    additionalProperties: boolean;
    required: string[];
    properties: {
        schema_version: {
            type: string;
            const: number;
            description: string;
        };
        status: {
            type: string;
            enum: string[];
            description: string;
        };
        code: {
            oneOf: ({
                type: string;
                enum: string[];
            } | {
                type: string;
                enum?: undefined;
            })[];
            description: string;
        };
        operation_id: {
            oneOf: {
                type: string;
            }[];
            description: string;
        };
        replayed: {
            type: string;
            description: string;
        };
        retryable: {
            type: string;
            description: string;
        };
        diagnostics: {
            type: string;
            description: string;
            items: {
                type: string;
                additionalProperties: boolean;
                required: string[];
                properties: {
                    code: {
                        type: string;
                    };
                    reason: {
                        type: string;
                    };
                    next_step: {
                        type: string;
                    };
                };
            };
        };
        data: {
            oneOf: {
                type: string;
            }[];
            description: string;
        };
    };
};
