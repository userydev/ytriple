import type {
  Degradation,
  ProviderCapabilities,
  SourceNote,
  TokenUsage,
  ToolCall,
} from "@ytriple/shared";
import type { ProviderRecording } from "./testing.js";

/**
 * Recorded runs.
 *
 * A scenario is one complete task captured in the shape `createRecordingAdapter`
 * produces: readable payloads plus the tool calls, sources and usage that came
 * back. Replaying one drives the whole runtime with no key and no network, which
 * is what lets the CLI harness, CI and the desktop demo host all exercise a real
 * task offline.
 *
 * It lives here because it is recording data, and it is a module rather than a
 * JSON file so a browser renderer can import it too.
 */
export interface RecordedScenarioEntry {
  key: string;
  agentId: string;
  phase: string;
  /** Serialised into the model reply. */
  payload?: Record<string, unknown>;
  text?: string;
  toolCalls?: ToolCall[];
  sources?: SourceNote[];
  usage?: TokenUsage;
  /** Degradations the recorded provider reported on this call. */
  degradations?: Degradation[];
}

export interface RecordedScenario {
  name: string;
  description: string;
  userInput: string;
  title?: string;
  /** Answers the scripted user gives, keyed by agentId or questionId. */
  answers: Record<string, string>;
  capabilities: ProviderCapabilities;
  entries: RecordedScenarioEntry[];
}

export const DEMO_SCENARIO: RecordedScenario = {
  "name": "demo",
  "description": "Recorded PRD run used by the offline harness and by CI. Model responses were captured once and are replayed verbatim, so this scenario needs no API key and no network.",
  "userInput": "我想做一个工具，把模糊的产品想法变成可以给开发看的 PRD，但是我现在还没想清楚具体流程。",
  "title": "yTriple PRD 工作台",
  "answers": {
    "conductor": "第一批用户就是我自己这样的独立开发者，一个人既做产品又写代码。",
    "researcher": "先看中文和英文的独立开发者工具生态，重点是把想法变成规格的那一类。",
    "specialist": "成功标准是十分钟内拿到一份能直接丢给开发或者 AI coding agent 的初稿。"
  },
  "capabilities": {
    "structuredOutput": "json_mode",
    "toolCalling": "sequential",
    "nativeWebSearch": false,
    "streaming": false,
    "maxContextTokens": 128000,
    "maxOutputTokens": 8192,
    "reasoningEffort": false,
    "visionInput": false,
    "costTier": "standard"
  },
  "entries": [
    {
      "key": "conductor#-#intake#0",
      "agentId": "conductor",
      "phase": "intake",
      "degradations": [
        {
          "kind": "structured_output",
          "from": "json_schema",
          "to": "json_mode",
          "detail": "model declares structuredOutput=json_mode; schema moved into the prompt and validated locally with repair retries"
        }
      ],
      "payload": {
        "understanding": "你想要一个把模糊产品想法收束成 PRD 初稿的工具，目标是这份初稿可以直接交给开发。你自己还没想清楚中间流程，所以流程设计也是这次任务的一部分。",
        "readiness": "needs_questions",
        "questions": [
          {
            "question": "第一批用户是你自己，还是别人？",
            "reason": "自用和给别人用会决定要不要做配置和引导。"
          }
        ]
      }
    },
    {
      "key": "researcher#-#member_questions#0",
      "agentId": "researcher",
      "phase": "member_questions",
      "degradations": [
        {
          "kind": "structured_output",
          "from": "json_schema",
          "to": "json_mode",
          "detail": "model declares structuredOutput=json_mode; schema moved into the prompt and validated locally with repair retries"
        }
      ],
      "payload": {
        "questions": [
          {
            "question": "调研范围放在哪个市场？中文独立开发者工具，还是英文的产品管理工具？",
            "reason": "两个市场的竞品和价格带完全不同，会直接改变我给出的定位建议。"
          }
        ]
      }
    },
    {
      "key": "specialist#-#member_questions#0",
      "agentId": "specialist",
      "phase": "member_questions",
      "degradations": [
        {
          "kind": "structured_output",
          "from": "json_schema",
          "to": "json_mode",
          "detail": "model declares structuredOutput=json_mode; schema moved into the prompt and validated locally with repair retries"
        }
      ],
      "payload": {
        "questions": [
          {
            "question": "什么样的结果算这个工具成功了？",
            "reason": "没有成功标准我无法判断 V1 该砍掉什么。"
          }
        ]
      }
    },
    {
      "key": "conductor#-#question_gate#0",
      "agentId": "conductor",
      "phase": "question_gate",
      "degradations": [
        {
          "kind": "structured_output",
          "from": "json_schema",
          "to": "json_mode",
          "detail": "model declares structuredOutput=json_mode; schema moved into the prompt and validated locally with repair retries"
        }
      ],
      "payload": {
        "approved": [
          {
            "questionId": "q-1"
          },
          {
            "questionId": "q-2"
          },
          {
            "questionId": "q-3"
          }
        ],
        "dropped_reason": "三个问题各自指向不同的决策，都值得问。"
      }
    },
    {
      "key": "conductor#-#brief#0",
      "agentId": "conductor",
      "phase": "brief",
      "degradations": [
        {
          "kind": "structured_output",
          "from": "json_schema",
          "to": "json_mode",
          "detail": "model declares structuredOutput=json_mode; schema moved into the prompt and validated locally with repair retries"
        }
      ],
      "payload": {
        "productObject": "一个桌面端 PRD 工作台：把一句模糊的产品想法，经过一次结构化对话，收束成一份可以直接交给开发的 prd.md。",
        "targetUser": "独立开发者和个人产品作者：一个人同时负责想清楚和写出来，没有产品经理帮忙收敛。",
        "coreScenario": "用户粘贴一段模糊想法，团队回问最多两三个关键问题，用户在同一个对话里回答，随后拿到一份 prd.md 初稿。",
        "painOrProblem": "模糊想法没法直接交给开发或 AI coding agent；把它整理成规格的那一步，恰恰是最容易卡住、也最容易被跳过的一步。",
        "v1Scope": [
          "共享对话：一个聊天面，用户只在这里说话",
          "Task Brief：派发前对用户可见的结构化任务说明",
          "单一交付物 prd.md",
          "本地只读工作区作为可选上下文"
        ],
        "nonGoals": [
          "团队协作与多人评论",
          "自定义 Agent 拓扑",
          "PRD 之外的第二种模板",
          "深度调研模式"
        ],
        "successCriteria": [
          "十分钟内拿到一份可以直接交给开发的 PRD 初稿",
          "初稿里的假设和未决问题是写明的，不是藏起来的",
          "用户不需要在多个输入框之间来回填表"
        ],
        "assumptions": [
          "用户自带模型 key，第一版不做托管额度",
          "第一批用户就是作者本人这类独立开发者"
        ],
        "openQuestions": [
          "PRD 之后第二个值得做的模板是什么"
        ],
        "memberTasks": [
          {
            "agentId": "researcher",
            "objective": "调研把想法变成规格这一类工具的现状，找出独立开发者场景下的空档。",
            "mustCover": [
              "中文和英文市场各至少一个具体竞品",
              "这些工具各自把重心放在哪一步",
              "事实与推断分开"
            ],
            "outOfScope": [
              "成功指标与 V1 范围的取舍",
              "撰写 PRD 正文"
            ]
          },
          {
            "agentId": "specialist",
            "objective": "从产品负责人视角审查这个方向：范围、非目标、成功标准与风险。",
            "mustCover": [
              "V1 该砍掉什么",
              "最大的产品风险和对应取舍",
              "缺失的 PRD 章节"
            ],
            "outOfScope": [
              "竞品清单与市场数据",
              "撰写 PRD 正文"
            ]
          }
        ]
      }
    },
    {
      "key": "researcher#-#member_work#0",
      "agentId": "researcher",
      "phase": "member_work",
      "usage": {
        "inputTokens": 2610,
        "outputTokens": 742
      },
      "degradations": [
        {
          "kind": "structured_output",
          "from": "json_schema",
          "to": "json_mode",
          "detail": "model declares structuredOutput=json_mode; schema moved into the prompt and validated locally with repair retries"
        }
      ],
      "payload": {
        "summary": "本轮没有联网能力，以下全部是既有认知下的判断，没有外部来源支撑。把想法变成规格这一步大致有两类工具：模板型（给你一张空表）和对话型（陪你问出答案）。面向独立开发者、并且以单一可交付文件收尾的那一档，我印象里是空的，但这一点需要联网后核实。",
        "facts": [],
        "inferences": [
          "模板型工具把认知负担原封不动地还给了用户，这正是独立开发者卡住的地方。",
          "对话型工具大多面向团队协作定价，单人用户的付费意愿和使用频率对不上。",
          "以单一文件收尾，比生成一整包报告更贴近独立开发者的真实下游动作：把文件丢给开发或 AI coding agent。"
        ],
        "competitive_set": [
          {
            "name": "Notion / Confluence PRD 模板",
            "angle": "提供结构，但不帮你想清楚内容"
          },
          {
            "name": "通用聊天助手",
            "angle": "能对话，但不收敛，产出散落在对话里"
          },
          {
            "name": "团队向产品管理工具",
            "angle": "围绕路线图和评审流程，单人场景太重"
          }
        ],
        "proposed_sections": [
          {
            "title": "定位差异",
            "body": "不与团队向产品管理工具争评审流程，而是占住「一个人把模糊想法收敛成一份可交付规格」这一步。"
          }
        ],
        "assumptions": [
          "以下竞品判断来自既有印象，本轮无外部来源支撑",
          "假设目标市场同时包含中文和英文的独立开发者工具生态"
        ],
        "open_questions": [
          "本轮没有联网能力，竞品清单与定位空档都未经核实，需要在有搜索能力时重跑一次调研",
          "中文独立开发者社区内部是否已有同类自建工具，完全未覆盖"
        ]
      }
    },
    {
      "key": "specialist#-#member_work#0",
      "agentId": "specialist",
      "phase": "member_work",
      "degradations": [
        {
          "kind": "structured_output",
          "from": "json_schema",
          "to": "json_mode",
          "detail": "model declares structuredOutput=json_mode; schema moved into the prompt and validated locally with repair retries"
        }
      ],
      "usage": {
        "inputTokens": 2480,
        "outputTokens": 690
      },
      "payload": {
        "summary": "方向成立，但 V1 的风险不在功能少，而在流程太重。只要提问超过三个、或者交付物超过一个文件，这个工具就退化成又一个需要维护的表单。",
        "checklist": [
          {
            "item": "目标用户是否具体",
            "verdict": "ok",
            "note": "独立开发者，一人分饰两角"
          },
          {
            "item": "核心场景是否单一",
            "verdict": "ok",
            "note": "粘贴想法到拿到 prd.md"
          },
          {
            "item": "成功标准是否可测",
            "verdict": "ok",
            "note": "十分钟内拿到可交付初稿"
          },
          {
            "item": "非目标是否明确",
            "verdict": "weak",
            "note": "需要写死「不做第二种模板」"
          },
          {
            "item": "失败路径是否覆盖",
            "verdict": "missing",
            "note": "没写没有联网能力时怎么办"
          }
        ],
        "missing_sections": [
          "联网或工作区不可用时的降级表现",
          "用户对生成结果不满意时的下一步动作"
        ],
        "risks": [
          {
            "risk": "提问环节变成问卷，用户在拿到价值之前就退出。",
            "tradeoff": "限制在最多两三个问题，其余一律以假设前进并写进 PRD。"
          },
          {
            "risk": "交付物膨胀成一整包文档，产品承诺被稀释。",
            "tradeoff": "只产出 prd.md，过程材料留在界面里不落盘。"
          },
          {
            "risk": "没有模型 key 的用户第一次打开就走不通。",
            "tradeoff": "配置自检前置，并在界面里说明缺什么。"
          }
        ],
        "scope_warnings": [
          "历史任务管理和模板市场都应推迟到 V1 之后",
          "不要在 V1 引入深度调研，它会把十分钟的承诺变成半小时"
        ],
        "recommendations": [
          "把「最多两三个问题」写成硬约束，而不是提示语",
          "把假设与未决问题作为 PRD 的固定章节，而不是可选附录",
          "在 PRD 中显式标注哪些结论没有来源支撑"
        ],
        "proposed_sections": [
          {
            "title": "失败与降级",
            "body": "联网不可用时继续产出 PRD，但在假设一节声明「本轮无外部来源支撑」；工作区不可用时不安排读代码的子任务。"
          }
        ],
        "assumptions": [
          "桌面端优先，手机端本轮不考虑"
        ],
        "open_questions": [
          "用户对初稿不满意时，是重跑还是在同一个对话里追加修改"
        ]
      }
    },
    {
      "key": "conductor#-#merge#0",
      "agentId": "conductor",
      "phase": "merge",
      "degradations": [
        {
          "kind": "structured_output",
          "from": "json_schema",
          "to": "json_mode",
          "detail": "model declares structuredOutput=json_mode; schema moved into the prompt and validated locally with repair retries"
        }
      ],
      "usage": {
        "inputTokens": 4120,
        "outputTokens": 1180
      },
      "payload": {
        "merge_notes": "本轮没有联网能力，调研只能给出未经核实的判断，我已经把这一点写进假设一节，并把需要联网复核的部分留在未决问题里。审查给出了 V1 的边界。",
        "product_summary": "yTriple 是一个桌面端 PRD 工作台。用户粘贴一段模糊的产品想法，一个小型 Agent 团队在同一个对话里回问最多两三个关键问题，然后产出一份可以直接交给开发或 AI coding agent 的 prd.md。产品承诺是一份干净的初稿，不是一包报告。",
        "problem_background": "独立开发者一个人同时负责想清楚和写出来。把模糊想法整理成规格的这一步既最容易卡住，也最容易被跳过，结果是需求停留在脑子里，开发从一句话开始猜。现有工具要么给一张空模板把认知负担还回来，要么能聊但不收敛，产出散落在对话里。",
        "target_users": "独立开发者与个人产品作者：自带模型 key，习惯本地工作，需要的是把想法变成可执行规格，而不是团队评审流程。",
        "core_scenario": "用户打开桌面应用，粘贴一段模糊想法；团队在共享对话里回问最多两三个关键问题；用户在同一个对话里作答；系统展示结构化的 Task Brief，随后并行执行调研与审查；最后产出 prd.md 并直接预览。",
        "v1_scope": [
          "共享对话：用户只在一个聊天面里说话，成员的问题由编排者统一筛选后提出",
          "Task Brief：派发前对用户可见的结构化任务说明",
          "并行执行：成员各自完成自己的子任务，过程以真实事件呈现",
          "单一交付物：prd.md，不覆盖已有文件",
          "本地只读工作区作为可选上下文"
        ],
        "non_goals": [
          "团队协作、评论与评审流程",
          "用户自定义 Agent 拓扑",
          "PRD 之外的第二种模板",
          "深度调研模式",
          "云端同步与账号体系"
        ],
        "functional_requirements": [
          {
            "title": "共享对话与提问闸门",
            "detail": "成员不直接对用户说话；它们提出候选问题，由编排者去重、裁剪、排序后放进共享对话。一轮提问最多三个问题，其余一律以假设前进。"
          },
          {
            "title": "Task Brief",
            "detail": "派发前必须产出结构化 Task Brief，包含产品对象、目标用户、核心场景、V1 范围、非目标、成功标准、假设、未决问题，以及按成员寻址的子任务。用户在派发前可见。"
          },
          {
            "title": "并行执行与真实事件",
            "detail": "被派发的成员并行执行，界面只渲染运行时真实事件；没有事件时显示等待中，不做假进度。"
          },
          {
            "title": "单一输出",
            "detail": "任务完成时只写入一个用户可见文件 prd.md，路径为 ytriple-outputs/<task-id>/prd.md，不覆盖已有文件。过程材料留在界面内，不落盘为交付物。"
          },
          {
            "title": "能力降级可见",
            "detail": "联网或工作区不可用时任务照常完成，但降级必须出现在事件流里，并在 PRD 的假设一节声明。"
          }
        ],
        "ux_requirements": [
          "空状态可以给示例，运行状态绝不展示假进度",
          "成员的提问出现在共享对话里，并标明是谁在问、为什么问",
          "Task Brief 以可折叠卡片形式常驻",
          "完成后中舱直接预览 prd.md，并提供打开输出目录"
        ],
        "data_permission_runtime_requirements": [
          "工作区只读：只读用户显式选择的目录，路径需在根目录内校验，默认排除 .git、node_modules、构建产物与日志",
          "写入只允许发生在输出目录，且不覆盖已有文件",
          "模型凭据存放在系统 keyring，不进入渲染进程、不写日志、不进事件流",
          "无账号即可完整跑通一次本地任务"
        ],
        "success_criteria": [
          "从粘贴想法到拿到 prd.md 不超过十分钟",
          "初稿包含完整章节，且假设与未决问题写在文档内",
          "一次任务只产生一个用户可见文件",
          "用户不需要在多个输入框之间来回填表"
        ],
        "assumptions": [
          "第一批用户是作者本人这类独立开发者，自带模型 key",
          "桌面端优先，手机端本轮不考虑",
          "本轮没有联网能力，竞品与市场判断均无外部来源支撑，属于待核实的假设"
        ],
        "open_questions": [
          "PRD 之后第二个值得做的模板是什么",
          "用户对初稿不满意时，是重跑任务还是在同一对话里追加修改",
          "中文独立开发者社区内部是否已有同类自建工具，本轮检索未覆盖"
        ]
      }
    }
  ]
};

export const SCENARIOS: Readonly<Record<string, RecordedScenario>> = Object.freeze({
  [DEMO_SCENARIO.name]: DEMO_SCENARIO,
});

export function scenarioNames(): string[] {
  return Object.keys(SCENARIOS);
}

export function findScenario(scenarioName: string): RecordedScenario {
  const scenario = SCENARIOS[scenarioName];
  if (!scenario) {
    throw new Error(
      `Unknown scenario "${scenarioName}". Available: ${scenarioNames().join(", ")}`,
    );
  }
  return scenario;
}

export function scenarioToRecording(scenario: RecordedScenario): ProviderRecording {
  return {
    providerId: "recorded",
    adapterId: "openai_compatible",
    capabilities: scenario.capabilities,
    entries: scenario.entries.map((entry) => ({
      key: entry.key,
      agentId: entry.agentId,
      phase: entry.phase,
      result: {
        text: entry.text ?? (entry.payload ? JSON.stringify(entry.payload) : ""),
        toolCalls: entry.toolCalls ?? [],
        usage: entry.usage ?? { inputTokens: 0, outputTokens: 0 },
        ...(entry.sources ? { sources: entry.sources } : {}),
        degradations: entry.degradations ?? [],
      },
    })),
  };
}
