# GPT-5.5 prompt anti-patterns

Things that hurt more than they help with GPT-5.5. Don't put these in the prompt.

| Anti-pattern | Why it hurts | Do instead |
|---|---|---|
| `ALWAYS think step by step before answering` | GPT-5.5 already reasons; this wastes tokens and can over-expand | Write success criteria and let it choose the path |
| `You are an expert with 20 years of experience…` | Flattery doesn't raise capability | Give the concrete task context (which system, which spec) |
| `Be detailed and thorough` | Read as "longer = better" | Give a word limit + the fields that must appear |
| `NEVER hallucinate` | The model can't act on it | "Cite sources for factual claims" + a retrieval budget |
| `If you don't know, say I don't know` | Too weak | "Use the minimum evidence sufficient to answer; if no citable support exists, say so explicitly" |
| A long `step 1 / step 2 / step 3` script | Over-specifies and narrows the search space | Success criteria + freedom to choose the approach |
| Repeated `very important` / `critical` / `must` | Inflation; the model starts ignoring them | Say why it matters once, clearly |
| `[paste your code here]` | The target can read files | List absolute paths and have it read them itself |
| Defaulting to the highest reasoning effort "to be safe" | Wastes budget; GPT-5.5 reasons efficiently | Start lower and escalate only if the bar isn't met |

Rule of thumb: every sentence should change the model's behavior. If removing it
wouldn't change the output, remove it.
